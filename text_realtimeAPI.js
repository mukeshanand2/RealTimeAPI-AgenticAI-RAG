const express = require('express');
const { WebSocketServer } = require('ws');
const { readFileSync } = require('fs');
const { createServer } = require('http');
const { executeWeather, getDialogChunks, executeInput } = require('./tool.js');
const WebSocket = require('ws');
const _ = require('lodash');
const readline = require('readline');

const config = JSON.parse(readFileSync('./config.json', 'utf-8'));
const OPENAI_KEY = config.openai_api_key;

// Load tools from tool.json
const { initialTools, helperTools } = JSON.parse(readFileSync('./tool.json', 'utf-8'));

// Get tools based on dialog names
const getToolsForDialogNames = (dialogNames) => {
  const availableTools = [...helperTools];
  return availableTools;
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
        const updateSessionEvent = {
          type: "session.update",
          session: {
            instructions: getInstructionsForState(currentState, currentContext),
            temperature: 0.7,
            tools: initialTools
          }
        };

        openaiWs.send(JSON.stringify(updateSessionEvent));
        openaiWs.send(JSON.stringify(createConversationItem(messages[0].content, "user", "input_text")));
        openaiWs.send(JSON.stringify(createResponse()));
        resolve(openaiWs);
      });

      openaiWs.on('message', (data) => handleMessage(data, openaiWs));

      openaiWs.on('error', (error) => {
        console.error(`❌ WebSocket error:`, error);
        reject(error);
      });
    });
  } else {
    const updateSessionEvent = {
      type: "session.update",
      session: {
        instructions: getInstructionsForState(currentState, currentContext),
        temperature: 0.7,
        tools: initialTools
      }
    };

    openaiWs.send(JSON.stringify(updateSessionEvent));
    openaiWs.send(JSON.stringify(createConversationItem(messages[0].content, "user", "input_text")));
    openaiWs.send(JSON.stringify(createResponse()));
  }
}

function startConversation(openaiWs) {
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

function createConversationItem(content, role, msgType = "input_text") {
  console.log("🚀 ~ server.js:143 ~ createConversationItem ~ role:", content, role);
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: role,
      content: [
        {
          type: msgType,
          text: content
        }
      ]
    }
  };
}

function createResponse(instructions) {
  return {
    type: "response.create",
    response: {
      modalities: ["text"],
      instructions: instructions,
      tool_choice: "auto"
    }
  };
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

// Start the conversation
console.log('Starting chat with OpenAI (type "exit" to quit)');
handleConversation(null);

function handleMessage(data, openaiWs) {
  try {
    const payload = data.toString();
    const parsed = JSON.parse(payload);
    console.log(`📥 WebSocket received message type:`, parsed.type);

    if (parsed.type === "error") {
      console.error(`❌ WebSocket error:`, _.get(parsed, 'error.message'));
      process.stdout.write('\n[ERROR] ' + _.get(parsed, 'error.message') + '\n');
      return;
    }

    if (parsed.type === "response.done") {
      let responseDetails = _.get(parsed, 'response.output[0]');
      const content = _.get(responseDetails, 'content[0].text');

      if (responseDetails.type === "function_call") {
        const functionName = responseDetails.name;
        console.log("🚀 ~ server.js:186 ~ openaiWs.on ~ functionName:-------------------------------->", functionName);
        try {
          const argumentsObj = JSON.parse(responseDetails.arguments);

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

                    const updateSessionEvent = {
                      type: "session.update",
                      session: {
                        instructions: `You have received the following dialog chunks: ${JSON.stringify(dialogResponse)}
                        
                        Based on the available intents, determine the appropriate function to use:
                        ${tools.map(tool => `- For ${tool.name === 'executeWeather' ? 'weather-related' : 'other'} queries, use ${tool.name} function`).join('\n')}
                        Please provide a natural response based on the available intents.`,
                        temperature: 0.7,
                        tools: tools
                      }
                    };
                    openaiWs.send(JSON.stringify(updateSessionEvent));
                    const dialogResponseText = typeof dialogResponse === 'object' ? JSON.stringify(dialogResponse) : dialogResponse;
                    openaiWs.send(JSON.stringify(createConversationItem(dialogResponseText, "system", "input_text")));
                    openaiWs.send(JSON.stringify(createResponse()));
                  }
                })
                .catch(error => {
                  console.error('Error in getDialogChunks:', error);
                  openaiWs.send(JSON.stringify(createConversationItem('Error processing dialog chunks', "system", "input_text")));
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
                    openaiWs.send(JSON.stringify(createConversationItem(weatherResponseText, "system", "input_text")));
                    openaiWs.send(JSON.stringify(createResponse(getInstructionsForState(currentState, currentContext))));
                    currentState = conversationStates.EXECUTION_COMPLETE;
                    setTimeout(() => {
                      currentState = conversationStates.INITIAL;
                      currentContext = { city: null, dialog: null, queryType: null, dialogChunks: null };
                    }, 1000);
                  }
                })
                .catch(error => {
                  console.error('Error in executeWeather:', error);
                  openaiWs.send(JSON.stringify(createConversationItem('Error getting weather information', "system", "input_text")));
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
                    openaiWs.send(JSON.stringify(createConversationItem(executionResponseText, "assistant", "text")));
                    currentState = conversationStates.EXECUTION_COMPLETE;
                    openaiWs.send(JSON.stringify(createResponse(getInstructionsForState(currentState, currentContext))));
                    setTimeout(() => {
                      currentState = conversationStates.INITIAL;
                      currentContext = { city: null, dialog: null, queryType: null, dialogChunks: null };
                    }, 1000);
                  }
                })
                .catch(error => {
                  console.error('Error in executeInput:', error);
                  openaiWs.send(JSON.stringify(createConversationItem('Error executing input', "system", "input_text")));
                });
            }
          }
        } catch (parseError) {
          console.error(`❌ Error parsing function arguments:`, parseError);
          openaiWs.send(JSON.stringify(createConversationItem('Error parsing function arguments', "system", "input_text")));
        }
      } else if (responseDetails.type === "message" && !_.isEmpty(content)) {
        process.stdout.write('\n\n' + content + '\n\n');
        startConversation(openaiWs);
      }
    }
  } catch (err) {
    console.error(`❌ WebSocket JSON parse error:`, err.message);
  }
}

