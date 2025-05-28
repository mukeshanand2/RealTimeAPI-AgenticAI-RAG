# 🎧 Real-Time Conversational Agent using OpenAI WebSockets

A Node.js-based real-time assistant using OpenAI’s WebSocket API (`gpt-4o-mini-realtime-preview`) for voice/text conversations with dynamic function execution.

---

## ⚙️ Setup & Run

### Prerequisites

* Node.js v18+
* `sox` (for voice): `sudo apt install sox`

### One-Liner to Setup & Run

```bash
npm install ws axios lodash speaker node-record-lpcm16 readline && node server.js
```

### Config

Create `config.json`:

```json
{
  "openai_api_key": "sk-...your-openai-key..."
}
```

---

## 📦 Features

* 🧠 Intent detection via `getDialogChunks`
* 🌦️ Weather via Open-Meteo API (`executeWeather`)
* 🧰 Function routing via OpenAI tool calls
* 🎤 Voice input/output support
* 🔄 Conversation state logic
* 📡 Realtime via WebSocket streaming

---

## 📁 Project Structure

```
├── server.js       # WebSocket + voice + logic
├── tool.js         # Tool logic (weather, intent)
├── tool.json       # Tool definitions
├── config.json     # API key (gitignored)
└── README.md       # Documentation
```

---

## ⌨️ Controls

* `r` → Start/stop voice recording
* `q` → Quit

---


## 💬 Examples

* "What's the weather in Tokyo?" → `executeWeather`
* "Show product options" → `getDialogChunks` → `executeInput`

---

## 🔗 References

* [OpenAI Real-time WebSocket Guide](https://platform.openai.com/docs/guides/realtime#connect-with-websockets)
* [OpenAI Real-time Client Events](https://platform.openai.com/docs/api-reference/realtime-client-events)

---
