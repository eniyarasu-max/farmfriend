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

    // Converts one message's `content` into Gemini `parts`. The frontend
    // (index.html) sends Claude/Anthropic-shaped content: either a plain
    // string, or an array of blocks like
    //   { type: 'text', text: '...' }
    //   { type: 'document', source: { type: 'base64', media_type, data }, title }
    // Gemini's REST API doesn't understand that block shape directly, so
    // each block is translated into the equivalent Gemini part:
    //   text block      -> { text: '...' }
    //   document block   -> { inlineData: { mimeType, data } }
    function toGeminiParts(content) {
      if (typeof content === 'string') {
        return [{ text: content }];
      }
      if (!Array.isArray(content)) {
        return [{ text: String(content ?? '') }];
      }

      const parts = [];
      for (const block of content) {
        if (!block) continue;

        if (block.type === 'text') {
          parts.push({ text: block.text || '' });
        } else if (block.type === 'document' && block.source && block.source.type === 'base64') {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type || 'application/pdf',
              data: block.source.data
            }
          });
        } else if (block.type === 'image' && block.source && block.source.type === 'base64') {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type || 'image/png',
              data: block.source.data
            }
          });
        }
        // Unknown block types are skipped rather than sent malformed.
      }
      // Gemini rejects parts arrays with no content — fall back to an empty
      // text part so a message with only an unsupported block doesn't 400.
      return parts.length ? parts : [{ text: '' }];
    }

    // 2. Safely filter and map conversation roles
    const geminiContents = [];

    for (const msg of messages) {
      // Extract system prompts if they were sent inside the messages array
      if (msg.role === 'system') {
        systemInstructionText = typeof msg.content === 'string' ? msg.content : systemInstructionText;
        continue;
      }

      // Properly map both 'assistant' and 'model' to Gemini's 'model' role.
      // Everything else becomes 'user'.
      const mappedRole = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';

      geminiContents.push({
        role: mappedRole,
        parts: toGeminiParts(msg.content)
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
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: data.error?.message || 'Gemini API failed to respond.' })
      };
    }

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't process that.";

    // IMPORTANT: the frontend filters this array for blocks where
    // `type === 'text'` before reading them. Omitting `type` here means
    // every reply gets silently filtered out client-side and the farmer
    // only ever sees the "couldn't put together an answer" fallback —
    // so `type: 'text'` below is required, not decorative.
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ content: [{ type: 'text', text: replyText }] })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal Server Error: ' + error.message })
    };
  }
};
