const { readFileSync } = require('fs');
const config = JSON.parse(readFileSync('./config.json', 'utf-8'));
const axios = require('axios');
const _ = require('lodash');

async function processInput(query) {
  // This is a non-math query: "${query}". for all non math queries, return a helpful response.
  return `This is a non-math query: "${query}". Here's a helpful response.`;
}

async function executeWeather(city) {
  console.log("🚀 ~ processInput.js:8 ~ executeWeather ~ city:", city);
  try {
    const weather = await getWeather(city);
    if (!_.isEmpty(weather)) {
      return weather;
    }
    return `Weather information for ${city} is currently unavailable. Please try again later.`;
  } catch (error) {
    console.error("Error fetching weather:", error.message);
    return `Weather information for ${city} is currently unavailable. Please try again later.`;
  }
}

async function getWeather(city) {
  try {
    // First get coordinates using geocoding API
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}`;
    console.log("\nGeocoding API call:");
    console.log(`curl "${geocodeUrl}"`);

    const geocodeResponse = await axios.get(geocodeUrl);
    const geocodeData = geocodeResponse.data;

    if (!geocodeData.results || geocodeData.results.length === 0) {
      console.error("No location found for:", city);
      return `No location found for ${city}. Please check the city name and try again.`;
    }

    const location = geocodeData.results[0];
    console.log("Found location:", location.name, location.country);

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=${location.timezone}`;
    const weatherResponse = await axios.get(weatherUrl);
    const weatherData = weatherResponse.data;

    if (!weatherData.current) {
      console.error("Invalid weather response format:", weatherData);
      return null;
    }

    const weatherCodes = {
      0: "Clear sky",
      1: "Mainly clear",
      2: "Partly cloudy",
      3: "Overcast",
      45: "Foggy",
      48: "Depositing rime fog",
      51: "Light drizzle",
      53: "Moderate drizzle",
      55: "Dense drizzle",
      61: "Slight rain",
      63: "Moderate rain",
      65: "Heavy rain",
      71: "Slight snow",
      73: "Moderate snow",
      75: "Heavy snow",
      77: "Snow grains",
      80: "Slight rain showers",
      81: "Moderate rain showers",
      82: "Violent rain showers",
      85: "Slight snow showers",
      86: "Heavy snow showers",
      95: "Thunderstorm",
      96: "Thunderstorm with slight hail",
      99: "Thunderstorm with heavy hail"
    };

    const weatherInfo = {
      temperature: weatherData.current.temperature_2m,
      humidity: weatherData.current.relative_humidity_2m,
      windSpeed: weatherData.current.wind_speed_10m,
      condition: weatherCodes[weatherData.current.weather_code] || "Unknown"
    };

    return `Current weather in ${location.name}, ${location.country}: ${weatherInfo.temperature}°C, ${weatherInfo.condition}. Humidity: ${weatherInfo.humidity}%, Wind Speed: ${weatherInfo.windSpeed} km/h`;
  } catch (error) {
    console.error("Weather API Error:", error.message);
    if (error.response) {
      console.error("Response status:", error.response);
    }
    return null;
  }
}

async function getDialogChunks(userInput) {
  // This is a dialog chunks query: "${userInput}".
  let dialogChunks = {
    dialogNames: ['weather', 'showBanner', 'dialog']
  }
  return dialogChunks;
}

async function executeInput(intent) {
  // This is a dialog chunks query: "${city}".
  return `internt in executeInput test : ${intent}.`;
}

module.exports = {
  processInput,
  executeWeather,
  getDialogChunks,
  executeInput
};
