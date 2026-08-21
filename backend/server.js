import express from 'express';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getGoogleSheetRows, isGoogleSheetConfigured, searchGoogleSheet } from './googleSheets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from the project root and optionally from backend/.env.
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

const developerIdentityResponse = 'My developer is Mostafizur Rahman. This AI model was developed by Mostafizur Rahman and is powered by an AI model through.';
const developerIdentitySystemPrompt = `You are 𝐏𝐢𝐩𝐢𝐥𝐢𝐤𝐚 𝐀𝐈.

This application was developed by Mostafizur Rahman.

If anyone asks:
- Who is your developer?
- Who created you?
- Who made you?
- Who built this app?
- Who built this application?
- Who owns this app?
- Who developed this application?
- Who is your creator?
- Who is your owner?
- Who is your maker?
- Who is your author?
- Who is your founder?
- Who is your programmer?
- Who is your engineer?
- About Mostafizur Rahman.
- Who is Mostafizur Rahman?

Always answer:

"My developer is Mostafizur Rahman."

If someone asks about the AI model or technology, answer:

"This application was developed by Mostafizur Rahman ."

Do not claim that this application was developed by Meta, OpenAI, Google, or Groq.`;

const sheetSearchTools = [
  {
    type: 'function',
    function: {
      name: 'search_google_sheet',
      description: 'Search information stored in the user\'s Google Sheet and return matching rows.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The text to search in the sheet such as a person name, ID, phone number, course, status, payment, or any other column value.'
          }
        },
        required: ['query']
      }
    }
  }
];

const developerIdentityPatterns = [
  /\bwho is your developer\b/i,
  /\bwho created you\b/i,
  /\bwho made you\b/i,
  /\bwho built you\b/i,
  /\bdeveloper\??\b/i,
  /\bcreator\??\b/i,
  /\bwho owns this app\b/i,
  /\bwho developed this application\b/i,
  /\bwho built this app\b/i,
  /\bwho built this application\b/i
];

const isDeveloperIdentityQuestion = (message) => {
  const normalizedMessage = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return developerIdentityPatterns.some((pattern) => pattern.test(normalizedMessage));
};

const buildChatMessages = (messages) => [
  {
    role: 'system',
    content: `${developerIdentitySystemPrompt}\n\nYou must answer in the same language as the user. If the user asks in Bengali, respond in Bengali. If the user asks in English, respond in English. If a Google Sheet lookup returns rows, use only the information from those rows and do not invent additional data. If no matching data is found in the Google Sheet, reply in the user\'s language: "দুঃখিত, Google Sheet-এ এই তথ্যটি পাওয়া যায়নি।" in Bengali or "Sorry, this information was not found in the Google Sheet." in English.`
  },
  ...messages
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || '')
    }))
    .filter((message) => message.content.trim().length > 0)
];

const getLastUserMessage = (messages) => {
  const userMessage = [...messages].reverse().find((message) => message.role === 'user');
  return userMessage?.content || '';
};

const getProviderConfig = (useProvider) => {
  if (useProvider === 'openai') {
    return {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      name: 'OpenAI',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    };
  }

  if (useProvider === 'groq') {
    return {
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      name: 'Groq',
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b'
    };
  }

  return {
    endpoint: 'https://api.cohere.com/v2/chat',
    name: 'Cohere',
    model: process.env.COHERE_MODEL || 'command-r-plus'
  };
};

const getPreferredProvider = () => {
  const envProvider = process.env.API_PROVIDER?.toLowerCase();
  if (['openai', 'groq', 'cohere'].includes(envProvider)) {
    return envProvider;
  }

  if (process.env.OPENAI_API_KEY) {
    return 'openai';
  }

  if (process.env.GROQ_API_KEY) {
    return 'groq';
  }

  return 'cohere';
};

const sendMessengerTextMessage = async (senderPsid, responseText) => {
  const pageAccessToken = process.env.PAGE_ACCESS_TOKEN;
  if (!pageAccessToken) {
    throw new Error('PAGE_ACCESS_TOKEN is not configured.');
  }

  const facebookUrl = `https://graph.facebook.com/v16.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  const body = {
    recipient: { id: senderPsid },
    message: { text: responseText }
  };

  const fbResponse = await fetch(facebookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!fbResponse.ok) {
    const errorBody = await fbResponse.text();
    throw new Error(`Facebook Send API failed: ${fbResponse.status} ${errorBody}`);
  }
};

const getGoogleSheetToolResult = async (query) => {
  if (!isGoogleSheetConfigured()) {
    return { results: [], configured: false };
  }

  const rows = await getGoogleSheetRows();
  const results = searchGoogleSheet(query, rows);
  return { results, configured: true };
};

const getNotFoundGoogleSheetMessage = (query) => {
  const normalized = String(query || '').trim();
  if (!normalized) {
    return 'Sorry, this information was not found in the Google Sheet.';
  }

  const inBangla = /[\u0980-\u09FF]/.test(normalized);
  return inBangla
    ? 'দুঃখিত, Google Sheet-এ এই তথ্যটি পাওয়া যায়নি।'
    : 'Sorry, this information was not found in the Google Sheet.';
};

const getAiReply = async ({ messages: incomingMessages, requestedModel }) => {
  const messages = Array.isArray(incomingMessages)
    ? incomingMessages
    : [];

  if (!messages.length || !messages.some((item) => typeof item.content === 'string' && item.content.trim() !== '')) {
    throw { status: 400, message: 'A non-empty message is required.' };
  }

  const latestUserMessage = getLastUserMessage(messages);
  if (isDeveloperIdentityQuestion(latestUserMessage)) {
    return developerIdentityResponse;
  }

  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.COHERE_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    throw { status: 500, message: 'API key is not configured. Please set GROQ_API_KEY, OPENAI_API_KEY, COHERE_API_KEY, or API_KEY in backend/.env.' };
  }

  const useProvider = getPreferredProvider();
  const providerConfig = getProviderConfig(useProvider);
  const model = typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel.trim() : providerConfig.model;

  const requestPayload = {
    model,
    messages: buildChatMessages(messages),
    temperature: 0.2
  };

  if (useProvider === 'groq' && isGoogleSheetConfigured()) {
    requestPayload.tools = sheetSearchTools;
    requestPayload.tool_choice = 'auto';
  }

  const response = await fetch(providerConfig.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload)
  });

  const data = await response.json();
  if (!response.ok) {
    const rawMessage = data?.error?.message || `${providerConfig.name} API request failed.`;
    const lower = rawMessage.toLowerCase();
    let userMessage = rawMessage;
    let statusCode = response.status;

    if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('rate limit exceeded')) {
      userMessage = `${providerConfig.name} quota has been reached or is not available for this API key. Please check your ${providerConfig.name} plan or use a different key.`;
      statusCode = 429;
    } else if (lower.includes('model') && lower.includes('not found')) {
      userMessage = `The ${providerConfig.name} model '${providerConfig.model}' is unavailable. Update ${providerConfig.name === 'Groq' ? 'GROQ_MODEL' : 'OPENAI_MODEL'} in backend/.env to a supported model.`;
      statusCode = 400;
    } else if (lower.includes('permission') || lower.includes('access denied')) {
      userMessage = `Your ${providerConfig.name} API key does not have permission to access this model. Check your ${providerConfig.name} account settings.`;
      statusCode = 403;
    }

    throw { status: statusCode, message: userMessage, details: rawMessage };
  }

  const assistantMessage = data?.choices?.[0]?.message;
  const toolCalls = assistantMessage?.tool_calls || [];

  if (useProvider === 'groq' && toolCalls.length > 0) {
    const toolCall = toolCalls[0];
    const toolName = toolCall?.function?.name;
    const argumentsText = toolCall?.function?.arguments || '{}';

    if (toolName === 'search_google_sheet') {
      const parsedArgs = JSON.parse(argumentsText || '{}');
      const query = String(parsedArgs.query || '').trim();

      if (!query) {
        return 'Sorry, this information was not found in the Google Sheet.';
      }

      const { results, configured } = await getGoogleSheetToolResult(query);
      if (!configured) {
        return 'Google Sheets credentials are not configured yet. Please add GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY in the backend .env file.';
      }

      if (!results.length) {
        return getNotFoundGoogleSheetMessage(query);
      }

      const toolResult = JSON.stringify({ results });
      const followUpMessages = [
        ...buildChatMessages(messages),
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.function.name,
                arguments: argumentsText
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        }
      ];

      const followUpResponse = await fetch(providerConfig.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: followUpMessages,
          temperature: 0.2
        })
      });

      const followUpData = await followUpResponse.json();
      if (!followUpResponse.ok) {
        const rawMessage = followUpData?.error?.message || 'Google Sheet lookup failed.';
        throw { status: followUpResponse.status, message: rawMessage };
      }

      return followUpData?.choices?.[0]?.message?.content || getNotFoundGoogleSheetMessage(query);
    }
  }

  return assistantMessage?.content || 'No response generated.';
};

const app = express();
// Fall back to 5009 if the environment does not specify a port.
const requestedPort = Number(process.env.PORT || 5009);

// Log token configuration at startup so webhook verification issues can be diagnosed.
console.log('Loaded environment:', {
  PORT: requestedPort,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN ? 'configured' : 'missing',
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN ? 'configured' : 'missing'
});

// Enable cross-origin requests and body parsing for JSON and URL-encoded payloads.
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const frontendDistPath = path.resolve(__dirname, '../frontend/dist');

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN?.trim();
  const mode = String(req.query['hub.mode'] || req.query.mode || '').trim();
  const token = String(req.query['hub.verify_token'] || req.query.verify_token || '').trim();
  const challenge = String(req.query['hub.challenge'] || req.query.challenge || '').trim();

  console.log('Webhook verification request', {
    mode,
    tokenReceived: token ? '***' : 'missing',
    expectedToken: VERIFY_TOKEN ? '***' : 'missing',
    challenge
  });

  if (!VERIFY_TOKEN) {
    console.error('Webhook verify token not configured in environment.');
    return res.status(500).send('VERIFY_TOKEN not configured.');
  }

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  console.warn('Webhook verification failed', {
    mode,
    tokenReceived: token ? '***' : 'missing',
    expectedToken: VERIFY_TOKEN ? '***' : 'missing'
  });
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object !== 'page') {
    return res.sendStatus(404);
  }

  try {
    if (!process.env.PAGE_ACCESS_TOKEN) {
      console.error('PAGE_ACCESS_TOKEN is not configured.');
      return res.status(500).json({ error: 'PAGE_ACCESS_TOKEN is not configured in backend/.env.' });
    }

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        // Ignore delivery, read receipts, and echo events.
        if (event.delivery || event.read || event.message?.is_echo) {
          continue;
        }

        if (event.message && typeof event.message.text === 'string') {
          const senderPsid = event.sender?.id;
          const userText = event.message.text.trim();

          if (!senderPsid || !userText) {
            continue;
          }

          const reply = await getAiReply({
            messages: [{ role: 'user', content: userText }]
          });

          await sendMessengerTextMessage(senderPsid, reply);
        }
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Messenger webhook error:', error);
    return res.status(500).json({ error: 'Messenger webhook processing failed.' });
  }
});

app.use(express.static(frontendDistPath));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found.' });
  }

  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

// Receive chat messages from the frontend and forward them to the configured provider.
app.post('/api/google-sheet/search', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'A search query is required.' });
    }

    if (!isGoogleSheetConfigured()) {
      return res.status(500).json({ error: 'Google Sheets credentials are not configured. Please set GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY in the backend .env file.' });
    }

    const rows = await getGoogleSheetRows();
    const results = searchGoogleSheet(query, rows);
    return res.json({ results });
  } catch (error) {
    console.error('Google Sheet search error:', error);
    return res.status(500).json({ error: error.message || 'Unable to search the Google Sheet.' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages: incomingMessages, message, model: requestedModel } = req.body;
    const messages = Array.isArray(incomingMessages) && incomingMessages.length > 0
      ? incomingMessages
      : typeof message === 'string' && message.trim() !== ''
        ? [{ role: 'user', content: message.trim() }]
        : [];

    if (!messages.length || !messages.some((item) => typeof item.content === 'string' && item.content.trim() !== '')) {
      return res.status(400).json({ error: 'A non-empty message is required.' });
    }

    const reply = await getAiReply({ messages, requestedModel });
    return res.json({ reply });
  } catch (error) {
    if (error?.status && error?.message) {
      return res.status(error.status).json({ error: error.message, details: error.details || undefined });
    }

    console.error('Chat error:', error);
    return res.status(500).json({ error: 'Server error while contacting the configured AI provider.' });
  }
});

const startServer = (portToUse) => {
  const server = app.listen(portToUse, '0.0.0.0', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : portToUse;
    console.log(`Backend running on http://localhost:${actualPort}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`Port ${portToUse} is busy. Trying an available port instead...`);
      server.close(() => startServer(0));
    } else {
      console.error('Failed to start backend server:', error);
      process.exit(1);
    }
  });
};

startServer(requestedPort);
