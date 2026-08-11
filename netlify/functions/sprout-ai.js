exports.handler = async (event, context) => {
  // 1. Handle Preflight/CORS requests
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

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    let systemInstructionText = body.system || "";
    const messages = body.messages || [];

    // 2. Safely filter and map conversation roles
    const geminiContents = [];
    
    for (const msg of messages) {
      // Extract system prompts if they were sent inside the messages array
      if (msg.role === 'system') {
        systemInstructionText = msg.content;
        continue;
      }
      
      // Properly map both 'assistant' and 'model' to Gemini's 'model' role. 
      // Everything else becomes 'user'.
      const mappedRole = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';
      
      geminiContents.push({
        role: mappedRole,
        parts: [{ text: msg.content }]
      });
    }

    const payload = {
      contents: geminiContents,
    };

    // 3. Attach system instructions natively
    if (systemInstructionText) {
      payload.systemInstruction = {
        parts: [{ text: systemInstructionText }]
      };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

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

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't process that.";

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ content: [{ text: replyText }] })
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error: ' + error.message })
    };
  }
};
