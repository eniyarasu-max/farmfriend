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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Fails fast with a readable message instead of sending a doomed
      // request to Gemini (which otherwise surfaces as a confusing 400/502
      // with no clue that the env var is the problem).
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Server is missing GEMINI_API_KEY — set it in Netlify Site settings → Environment variables, then redeploy.' })
      };
    }

    // Netlify's synchronous functions cap request/response payloads around
    // 6MB; a large attached PDF (or several) can push a request over that
    // and Netlify's gateway kills it with a bare 502 before our own error
    // handling ever runs. Check early so the farmer gets an explicit message.
    const rawBodySize = Buffer.byteLength(event.body || '', 'utf8');
    const MAX_BODY_BYTES = 4.5 * 1024 * 1024; // headroom under the ~6MB gateway limit
    if (rawBodySize > MAX_BODY_BYTES) {
      return {
        statusCode: 413,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'That request was too large (likely from attached PDF guides). Try again with fewer or smaller guides in the library.' })
      };
    }

    const body = JSON.parse(event.body);
    let systemInstructionText = body.system || "";
    let messages = body.messages || [];

    // --- FIX: trim history so latency doesn't grow with the conversation ---
    // Every extra turn (and every previously-attached PDF re-sent as base64
    // inside it) adds payload size and Gemini processing time, which is what
    // was pushing calls past the 9s abort and surfacing as a 504. Only the
    // most recent turns carry real context value for a Q&A chatbot like this.
    const MAX_HISTORY_MESSAGES = 12; // ~6 user/assistant exchanges
    if (messages.length > MAX_HISTORY_MESSAGES) {
      messages = messages.slice(-MAX_HISTORY_MESSAGES);
    }

    // Converts one message's `content` into Gemini `parts`. The frontend
    // (index.html) sends Claude/Anthropic-shaped content: either a plain
    // string, or an array of blocks like
    //   { type: 'text', text: '...' }
    //   { type: 'document', source: { type: 'base64', media_type, data }, title }
    // Gemini's REST API doesn't understand that block shape directly, so
    // each block is translated into the equivalent Gemini part:
    //   text block      -> { text: '...' }
    //   document block   -> { inlineData: { mimeType, data } }
    //
    // `dropAttachments`: when true, document/image blocks are skipped and
    // replaced with a short text placeholder instead of being sent again.
    // Used for every message except the latest one — a PDF attached three
    // turns ago doesn't need to be re-uploaded and re-processed by Gemini
    // on every subsequent turn; that repeated cost is what was driving the
    // 504 timeouts as conversations got longer.
    function toGeminiParts(content, dropAttachments) {
      if (typeof content === 'string') {
        return [{ text: content }];
      }
      if (!Array.isArray(content)) {
        return [{ text: String(content ?? '') }];
      }

      const parts = [];
      let droppedCount = 0;
      for (const block of content) {
        if (!block) continue;

        if (block.type === 'text') {
          parts.push({ text: block.text || '' });
        } else if (block.type === 'document' && block.source && block.source.type === 'base64') {
          if (dropAttachments) {
            droppedCount++;
            continue;
          }
          parts.push({
            inlineData: {
              mimeType: block.source.media_type || 'application/pdf',
              data: block.source.data
            }
          });
        } else if (block.type === 'image' && block.source && block.source.type === 'base64') {
          if (dropAttachments) {
            droppedCount++;
            continue;
          }
          parts.push({
            inlineData: {
              mimeType: block.source.media_type || 'image/png',
              data: block.source.data
            }
          });
        }
        // Unknown block types are skipped rather than sent malformed.
      }
      if (droppedCount > 0) {
        parts.push({ text: `[${droppedCount} attachment(s) from this earlier message omitted to keep the request fast]` });
      }
      // Gemini rejects parts arrays with no content — fall back to an empty
      // text part so a message with only an unsupported block doesn't 400.
      return parts.length ? parts : [{ text: '' }];
    }

    // 2. Safely filter and map conversation roles
    const geminiContents = [];
    const lastIndex = messages.length - 1;

    messages.forEach((msg, i) => {
      // Extract system prompts if they were sent inside the messages array
      if (msg.role === 'system') {
        systemInstructionText = typeof msg.content === 'string' ? msg.content : systemInstructionText;
        return;
      }

      // Properly map both 'assistant' and 'model' to Gemini's 'model' role.
      // Everything else becomes 'user'.
      const mappedRole = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';

      // Only the most recent message keeps its attachments in full.
      const dropAttachments = i !== lastIndex;

      geminiContents.push({
        role: mappedRole,
        parts: toGeminiParts(msg.content, dropAttachments)
      });
    });

    const payload = {
      contents: geminiContents,
    };

    // 3. Attach system instructions natively
    if (systemInstructionText) {
      payload.systemInstruction = {
        parts: [{ text: systemInstructionText }]
      };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    // Netlify's default synchronous function timeout is 10s. Racing our own
    // 9s abort against that means a slow Gemini call returns a clear 504
    // JSON error from us, instead of the platform silently killing the
    // function and the browser only ever seeing a bare 502.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        return {
          statusCode: 504,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'Sprout took too long to think this through (possibly a large attached guide) — try a shorter question or a smaller library.' })
        };
      }
      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }

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
