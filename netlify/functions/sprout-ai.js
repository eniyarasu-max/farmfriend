const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // 1. Parse the incoming Anthropic-formatted request from index.html
    const { system, messages } = JSON.parse(event.body);

    // 2. Map Anthropic roles to Gemini roles
    // Gemini expects 'model' instead of 'assistant', and uses a nested 'parts' structure
    const geminiContents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const payload = {
      contents: geminiContents,
    };

    // 3. Add system instructions if provided by the frontend
    if (system) {
      payload.systemInstruction = {
        parts: [{ text: system }]
      };
    }

    // 4. Connect to the Google AI Studio REST API
    // We are using gemini-1.5-flash here as it is highly recommended as a starting point
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: data.error?.message || 'Gemini API error' })
      };
    }

    // 5. Extract the text from Gemini's response structure
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";

    // 6. Shim the response back into the Anthropic format so index.html doesn't break
    const simulatedAnthropicResponse = {
      content: [
        { text: replyText }
      ]
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simulatedAnthropicResponse)
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
