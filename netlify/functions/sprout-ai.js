exports.handler = async (event, context) => {
  // 1. Handle Preflight/CORS requests (prevents browser block errors)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: 'Preflight call successful'
    };
  }

  // Only allow POST requests for the actual chat
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // 2. Parse the request coming from index.html
    const { system, messages } = JSON.parse(event.body);

    // 3. Convert Anthropic-style message history into Gemini's format
    const geminiContents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const payload = {
      contents: geminiContents,
    };

    // Add Sprout AI's system instructions if they exist
    if (system) {
      payload.systemInstruction = {
        parts: [{ text: system }]
      };
    }

    // 4. Set up the Google AI Studio connection
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'GEMINI_API_KEY environment variable is missing.' })
      };
    }

    // Connecting to the Gemini 3.6 Flash endpoint using the standard generateContent REST API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    // 5. Fetch the response from Google
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: data.error?.message || 'Gemini API failed to respond.' })
      };
    }

    // 6. Extract the AI's reply text
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't process that.";

    // 7. Format it back to what your frontend expects
    const simulatedAnthropicResponse = {
      content: [
        { text: replyText }
      ]
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(simulatedAnthropicResponse)
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error: ' + error.message })
    };
  }
};
