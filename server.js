const { readFileSync, writeFileSync } = require('fs');
const { executeWeather, getDialogChunks, executeInput } = require('./tool.js');
const WebSocket = require('ws');
const _ = require('lodash');
const readline = require('readline');
const recorder = require('node-record-lpcm16');
const Speaker = require('speaker');


const config = JSON.parse(readFileSync('./config.json', 'utf-8'));
const OPENAI_KEY = config.openai_api_key;

// Load tools from tool.json
const { initialTools, helperTools } = JSON.parse(readFileSync('./tool.json', 'utf-8'));

// Get tools based on dialog names
const getToolsForDialogNames = (dialogNames) => {
  const availableTools = [...helperTools];
  return availableTools;
};

// Audio configuration
const AUDIO_CONFIG = {
  sampleRate: 16000,
  channels: 1,
  audioType: 'raw',
  threshold: 0,
  silence: 1.0,
  format: 'pcm16',
  verbose: false,
  recordProgram: 'sox'
};

const VOICE_CONFIG = {
  enabled: true, // Set to true to enable voice support
  voice: "alloy",
  transcription: {
    model: "whisper-1"
  },
  turn_detection: {
    type: "server_vad",
    threshold: 0.8,
    prefix_padding_ms: 300,
    silence_duration_ms: 500
  }
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const conversationStates = {
  INITIAL: 'initial',
  QUERY_PROCESSING: 'query_processing',
  EXECUTION_COMPLETE: 'execution_complete'
};

let currentState = conversationStates.INITIAL;
let currentContext = {
  city: null,
  dialog: null,
  queryType: null
};

let audioHandler = null;

class AudioHandler {
  constructor(openaiWs) {
    this.openaiWs = openaiWs;
    this.isRecording = false;
    this.recording = null;
    this.audioChunks = [];
    this.hasActiveResponse = false;
    this.setupInputHandling();
  }

  setupInputHandling() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => this.handleKeyPress(key));
  }

  handleKeyPress(key) {
    const keyStr = key.toString().toLowerCase();

    if (keyStr === 'q') {
      console.log('\nQuitting application...');
      process.exit(0);
    } else if (keyStr === 'r') {
      if (!this.isRecording && !this.hasActiveResponse) {
        this.startRecording();
      } else if (this.isRecording) {
        this.stopRecording();
      }
    }
  }

  async startRecording() {
    if (this.isRecording || this.hasActiveResponse) {
      return;
    }

    console.log('\n🎤 Recording started... (Press "r" to stop)');
    this.isRecording = true;
    this.audioChunks = [];

    this.recording = recorder.record({
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      threshold: AUDIO_CONFIG.threshold,
      verbose: AUDIO_CONFIG.verbose,
      recordProgram: AUDIO_CONFIG.recordProgram
    });

    this.recording.stream()
      .on('data', (data) => this.handleAudioData(data))
      .on('error', (error) => this.handleRecordingError(error));
  }

  handleAudioData(data) {
    if (!this.isRecording || this.hasActiveResponse) {
      return;
    }

    this.audioChunks.push(data);
  }

  handleRecordingError(error) {
    console.error('Error recording audio:', error);
    this.isRecording = false;
    this.hasActiveResponse = false;
  }

  stopRecording() {
    if (!this.isRecording) {
      return;
    }

    console.log('\n⏹️ Recording stopped');
    if (this.recording) {
      this.recording.stop();
    }
    this.isRecording = false;
    this.recording = null;

    if (this.audioChunks.length > 0 && !this.hasActiveResponse) {
      const audioBuffer = Buffer.concat(this.audioChunks);
      const base64Audio = audioBuffer.toString('base64');
      console.log('Final audio data length:', base64Audio.length);

      if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
        // Send audio data
        const message = createConversationItem(base64Audio, "user", "input_audio");
        console.log('Sending final audio message');
        this.openaiWs.send(JSON.stringify(message));
        this.hasActiveResponse = true;
        const response = createResponse();
        console.log('Sending response:', JSON.stringify(response, null, 2));
        this.openaiWs.send(JSON.stringify(response));
      }
      this.audioChunks = [];
    }
  }

  toggleRecording() {
    if (!this.isRecording && !this.hasActiveResponse) {
      this.startRecording();
    } else if (this.isRecording) {
      this.stopRecording();
    }
  }

  quit() {
    console.log('\nQuitting application...');
    if (this.recording) {
      this.recording.stop();
    }
    if (this.openaiWs) {
      this.openaiWs.close();
    }
    process.exit(0);
  }
}

function startVoiceInput(openaiWs) {
  console.log('\n🎤 Voice Input Controls:');
  console.log('Press "r" to start/stop recording');
  console.log('Press "q" to quit the application');
  console.log('--------------------------------');

  audioHandler = new AudioHandler(openaiWs);

  // Handle process termination
  process.on('SIGINT', () => {
    audioHandler.quit();
  });
}

async function streamOpenAI(messages, openaiWs) {
  console.log("🚀 ~ server.js:22 ~ streamOpenAI ~ messages:", messages);
  
  if (!openaiWs) {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    return new Promise((resolve, reject) => {
      openaiWs.on('open', () => {
        console.log('📡 WebSocket opened');
        updateSession(openaiWs, getInstructionsForState(currentState, currentContext), initialTools);
        openaiWs.send(JSON.stringify(createConversationItem(messages[0].content, "user", VOICE_CONFIG.enabled ? "input_audio" : "input_text")));
        openaiWs.send(JSON.stringify(createResponse()));
        resolve(openaiWs);
      });

      openaiWs.on('message', (data) => {
        const message = JSON.parse(data.toString());
        console.log("WebSocket message received:", message.type);
        if (message.type === "error") {
          console.error("WebSocket error:", message.error);
        }
        handleMessage(data, openaiWs);
      });

      openaiWs.on('error', (error) => {
        console.error(`❌ WebSocket error:`, error);
        reject(error);
      });
    });
  } else {
    const tools = currentState === conversationStates.INITIAL ? initialTools : helperTools;
    updateSession(openaiWs, getInstructionsForState(currentState, currentContext), tools);
    openaiWs.send(JSON.stringify(createConversationItem(messages[0].content, "user", VOICE_CONFIG.enabled ? "input_audio" : "input_text")));
    openaiWs.send(JSON.stringify(createResponse()));
  }
}

function startConversation(openaiWs) {
  if (VOICE_CONFIG.enabled) {
    const updateSessionEvent = {
      type: "session.update",
      session: {
        instructions: getInstructionsForState(currentState, currentContext),
        temperature: 0.7,
        modalities: ["text", "audio"],
        voice: VOICE_CONFIG.voice,
        input_audio_format: "pcm16",
        input_audio_transcription: VOICE_CONFIG.transcription,
        turn_detection: VOICE_CONFIG.turn_detection,
        tools: initialTools
      }
    };
    openaiWs.send(JSON.stringify(updateSessionEvent));
    startVoiceInput(openaiWs);
  } else {
    rl.question('\nEnter your message (or type "exit" to quit)\n\n', async (userInput) => {
      if (userInput.toLowerCase() === 'exit') {
        if (openaiWs) {
          openaiWs.close();
        }
        rl.close();
        process.exit(0);
      }
      const messages = [
        { role: 'user', content: userInput }
      ];
      try {
        const newWs = await streamOpenAI(messages, openaiWs);
        if (newWs) {
          openaiWs = newWs;
        }
      } catch (error) {
        console.error('Error in streamOpenAI:', error);
        process.stdout.write('\n[ERROR] Failed to process message\n');
        startConversation(null);
      }
    });
  }
}

function handleConversation(openaiWs) {
  if (!openaiWs) {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    openaiWs.on('open', () => {
      console.log('📡 WebSocket opened');
      startConversation(openaiWs);
    });

    openaiWs.on('message', (data) => handleMessage(data, openaiWs));

    openaiWs.on('error', (error) => {
      console.error(`❌ WebSocket error:`, error);
      process.stdout.write('\n[ERROR] Connection failed\n');
      handleConversation(null);
    });

    openaiWs.on('close', () => {
      console.log(`🔴 WebSocket connection closed`);
      handleConversation(null);
    });
  } else {
    startConversation(openaiWs);
  }
}

function createContent(content, type, role) {
  console.log("🚀 ~ server.js:319 ~ createContent ~ type, role:", type, role);
  if (type === "input_audio") {
    return [{
      type: "input_audio",
      audio: content
    }];
  }
  return [{
    type: "input_text",
    text: content
  }];
}

function createConversationItem(content, role, msgType = "input_text") {
  console.log("🚀 ~ server.js:333 ~ createConversationItem ~ content:", content, role, msgType);
  let item = {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: role,
      content: createContent(content, msgType, role)
    }
  };
  return item;
}

function createResponse(instructions) {
  let response = {
    type: "response.create",
    response: {
      instructions: instructions,
      tool_choice: "auto",
      modalities: VOICE_CONFIG.enabled ? ["text", "audio"] : ["text"],
    }
  };
  if (VOICE_CONFIG.enabled) {
    response.response.voice = VOICE_CONFIG.voice;
    response.response.output_audio_format = "pcm16";
    response.response.temperature = 0.7;
    response.response.max_output_tokens = 4096;
  }

  return response;
}

function playAudio(base64Audio, isStreaming = false) {
  try {
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    console.log("Audio buffer length:", audioBuffer.length);
    
    if (!this.speaker) {
      this.speaker = new Speaker({
        channels: AUDIO_CONFIG.channels,
        bitDepth: 16,
        sampleRate: AUDIO_CONFIG.sampleRate,
        signed: true
      });
    }

    this.speaker.write(audioBuffer);
    
    if (!isStreaming) {
      this.speaker.end();
      this.speaker = null;
    }
  } catch (error) {
    console.error('Error processing audio:', error);
    if (this.speaker) {
      this.speaker.end();
      this.speaker = null;
    }
  }
}

function getInstructionsForState(state, context) {
  switch (state) {
    case conversationStates.INITIAL:
      return `You are a helpful assistant that can handle multiple types of queries:
1. For any query, first use getDialogChunks to understand available intents
2. Based on the dialog chunks, determine the appropriate function to use
3. Use the function that matches the intent from dialog chunks
4. For any other queries, use executeInput with the appropriate intent`;

    case conversationStates.QUERY_PROCESSING:
      return `You are processing a ${context.queryType} query. 
1. First analyze the dialog chunks to understand available intents
2. Use the function that matches the intent from dialog chunks
3. For any other queries, use executeInput with the appropriate intent
4. Format the response in a natural, conversational way`;

    case conversationStates.EXECUTION_COMPLETE:
      return `The execution is complete. Return to the initial state and:
1. Handle new queries appropriately
2. Reset context for the next interaction`;

    default:
      return `You are a helpful assistant. Please follow the conversation flow.`;
  }
}

function updateSession(openaiWs, instructions, tools = []) {
  const updateSessionEvent = {
    type: "session.update",
    session: {
      instructions: instructions,
      temperature: 0.7,
      modalities: VOICE_CONFIG.enabled ? ["text", "audio"] : ["text"],
      tools: tools
    }
  };
  if (VOICE_CONFIG.enabled) {
    updateSessionEvent.session.voice = VOICE_CONFIG.voice;
    updateSessionEvent.session.input_audio_transcription = VOICE_CONFIG.transcription;
    updateSessionEvent.session.turn_detection = VOICE_CONFIG.turn_detection;
  }
  openaiWs.send(JSON.stringify(updateSessionEvent));
}

// Start the conversation
console.log('Starting chat with OpenAI (type "exit" to quit)');
handleConversation(null);

function handleMessage(data, openaiWs) {
  try {
    const payload = data.toString();
    const parsed = JSON.parse(payload);
    console.log(`📥 WebSocket received message type:`, parsed.type);
    let responseDetails = _.get(parsed, 'response.output[0]');
    const content = _.get(responseDetails, 'content[0].text');

    if (parsed.type === "error") {
      console.error(`❌ WebSocket error:`, _.get(parsed, 'error.message'));
      process.stdout.write('\n[ERROR] ' + _.get(parsed, 'error.message') + '\n');
      if (_.get(parsed, 'error.message') === 'Conversation already has an active response') {
        return;
      }
      return;
    }

    if(parsed.type === "response.audio_transcript.done") {
      process.stdout.write('\n\n' + parsed.transcript + '\n\n');
    }

    // Handle audio chunks
    if (parsed.type === "response.audio.delta") {
      playAudio(parsed.delta, true);
    }

    // Handle audio completion
    if (parsed.type === "response.audio.done") {
      console.log("Audio playback complete");
      if (this.speaker) {
        this.speaker.end();
        this.speaker = null;
      }
      startConversation(openaiWs);
    }

    if (parsed.type === "response.done") {
      if (audioHandler) {
        audioHandler.hasActiveResponse = false;
      }
      
      if (parsed.response?.status === 'failed') {
        const errorDetails = _.get(parsed, 'response.status_details.error');
        console.error('❌ Response failed:', errorDetails);
        process.stdout.write('\n[ERROR] Failed to process audio: ' + JSON.stringify(errorDetails) + '\n');
        startConversation(openaiWs);
        return;
      }

      if (responseDetails?.type === "function_call") {
        const functionName = responseDetails?.name;
        console.log("🚀 ~ server.js:186 ~ openaiWs.on ~ functionName:-------------------------------->", functionName);
        try {
          const argumentsObj = JSON.parse(responseDetails?.arguments);

          if (functionName === 'getDialogChunks') {
            const query = _.get(argumentsObj, 'query');
            if (!_.isEmpty(query)) {
              currentContext.queryType = 'dialog';
              currentState = conversationStates.QUERY_PROCESSING;
              getDialogChunks(query)
                .then(dialogResponse => {
                  if (!_.isEmpty(dialogResponse)) {
                    currentContext.dialogChunks = dialogResponse;
                    const dialogNames = _.get(dialogResponse, 'dialogNames', []);
                    const tools = getToolsForDialogNames(dialogNames);

                    const instructions = `You have received the following dialog chunks: ${JSON.stringify(dialogResponse)}
                    Based on the available intents, determine the appropriate function to use:
                    ${tools.map(tool => `- For ${tool.name === 'executeWeather' ? 'weather-related' : 'other'} queries, use ${tool.name} function`).join('\n')}
                    
                    Please provide a natural response based on the available intents.`;

                    updateSession(openaiWs, instructions, tools);
                    const dialogResponseText = typeof dialogResponse === 'object' ? JSON.stringify(dialogResponse) : dialogResponse;
                    openaiWs.send(JSON.stringify(createConversationItem(dialogResponseText, "system", "input")));
                    openaiWs.send(JSON.stringify(createResponse()));
                  }
                })
                .catch(error => {
                  console.error('Error in getDialogChunks:', error);
                  openaiWs.send(JSON.stringify(createConversationItem('Error processing dialog chunks', "system", "input")));
                });
            }
          } else if (functionName === 'executeWeather') {
            const city = _.get(argumentsObj, 'city');
            if (!_.isEmpty(city)) {
              currentContext.city = city;
              currentContext.queryType = 'weather';
              currentState = conversationStates.QUERY_PROCESSING;
              executeWeather(city)
                .then(weatherResponse => {
                  if (!_.isEmpty(weatherResponse)) {
                    const weatherResponseText = typeof weatherResponse === 'object' ? JSON.stringify(weatherResponse) : weatherResponse;
                    openaiWs.send(JSON.stringify(createConversationItem(weatherResponseText, "system", "input")));
                    updateSession(openaiWs, getInstructionsForState(currentState, currentContext));
                    openaiWs.send(JSON.stringify(createResponse()));
                    currentState = conversationStates.EXECUTION_COMPLETE;
                    setTimeout(() => {
                      currentState = conversationStates.INITIAL;
                      currentContext = { city: null, dialog: null, queryType: null, dialogChunks: null };
                    }, 1000);
                  }
                })
                .catch(error => {
                  console.error('Error in executeWeather:', error);
                  openaiWs.send(JSON.stringify(createConversationItem('Error getting weather information', "system", "input")));
                });
            }
          } else if (functionName === 'executeInput') {
            const intent = _.get(argumentsObj, 'intent');
            if (!_.isEmpty(intent)) {
              currentContext.dialog = intent;
              currentContext.queryType = 'dialog';
              currentState = conversationStates.QUERY_PROCESSING;
              executeInput(intent)
                .then(executionResponse => {
                  if (!_.isEmpty(executionResponse)) {
                    const executionResponseText = typeof executionResponse === 'object' ? JSON.stringify(executionResponse) : executionResponse;
                    openaiWs.send(JSON.stringify(createConversationItem(executionResponseText, "assistant", "input")));
                    currentState = conversationStates.EXECUTION_COMPLETE;
                    updateSession(openaiWs, getInstructionsForState(currentState, currentContext));
                    openaiWs.send(JSON.stringify(createResponse()));
                    setTimeout(() => {
                      currentState = conversationStates.INITIAL;
                      currentContext = { city: null, dialog: null, queryType: null, dialogChunks: null };
                    }, 1000);
                  }
                })
                .catch(error => {
                  console.error('Error in executeInput:', error);
                  openaiWs.send(JSON.stringify(createConversationItem('Error executing input', "system", "input")));
                });
            }
          }
        } catch (parseError) {
          console.error(`❌ Error parsing function arguments:`, parseError);
          openaiWs.send(JSON.stringify(createConversationItem('Error parsing function arguments', "system", "input")));
        }
      } else if (responseDetails?.type === "message") {
        if (!_.isEmpty(content)) {
          process.stdout.write('\n\n' + content + '\n\n');
        }
      } else {
        console.log('No valid response content found');
        startConversation(openaiWs);
      }
    }
  } catch (err) {
    console.error(`❌ WebSocket JSON parse error:`, err.message);
    startConversation(openaiWs);
  }
}

