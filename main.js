const { app, BrowserWindow, globalShortcut } = require("electron");
const path = require("path");
const screenshot = require("screenshot-desktop");
const fs = require("fs");
const { OpenAI } = require("openai");
const mic = require("mic");

let config;
try {
  const configPath = path.join(__dirname, "config.json");
  const configData = fs.readFileSync(configPath, "utf8");
  config = JSON.parse(configData);

  if (!config.apiKey) {
    throw new Error("API key is missing in config.json");
  }

  if (!config.model) {
    config.model = "gpt-4o-mini";
    console.log("Model not specified in config, using default:", config.model);
  }
} catch (err) {
  console.error("Error reading config:", err);
  app.quit();
}

const openai = new OpenAI({ apiKey: config.apiKey });

let mainWindow;
let screenshots = [];
let multiPageMode = false;
let windowHidden = false;

function updateInstruction(instruction) {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send("update-instruction", instruction);
  }
}

function hideInstruction() {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send("hide-instruction");
  }
}

async function captureScreenshot() {
  try {
    hideInstruction();
    mainWindow.hide();
    await new Promise((res) => setTimeout(res, 200));

    const timestamp = Date.now();
    const imagePath = path.join(
      app.getPath("pictures"),
      `screenshot_${timestamp}.png`
    );
    await screenshot({ filename: imagePath });

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString("base64");

    mainWindow.show();
    return base64Image;
  } catch (err) {
    mainWindow.show();
    if (mainWindow.webContents) {
      mainWindow.webContents.send("error", err.message);
    }
    throw err;
  }
}

async function processScreenshots() {
  try {
    const messages = [
      {
        type: "text",
        text: "Can you solve the question for me with comments for each line, a brief summary of the solution up top, the time and space complexity for the solution at the bottom, and give the final answer/code?",
      },
    ];
    for (const img of screenshots) {
      messages.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${img}` },
      });
    }

    const response = await openai.chat.completions.create({
      model: config.model,
      messages: [{ role: "user", content: messages }],
      max_tokens: 5000,
    });

    mainWindow.webContents.send(
      "analysis-result",
      response.choices[0].message.content
    );
  } catch (err) {
    console.error("Error in processScreenshots:", err);
    if (mainWindow.webContents) {
      mainWindow.webContents.send("error", err.message);
    }
  }
}

function resetProcess() {
  screenshots = [];
  multiPageMode = false;
  mainWindow.webContents.send("clear-result");
  updateInstruction("Ctrl+Shift+S: Screenshot | Ctrl+Shift+A: Multi-mode");
}

function toggleWindowVisibility() {
  if (windowHidden) {
    mainWindow.show();
  } else {
    mainWindow.hide();
  }
  windowHidden = !windowHidden;
}

function moveWindow(direction) {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const step = 20;

  switch (direction) {
    case "up":
      mainWindow.setBounds({ ...bounds, y: bounds.y - step });
      break;
    case "down":
      mainWindow.setBounds({ ...bounds, y: bounds.y + step });
      break;
    case "left":
      mainWindow.setBounds({ ...bounds, x: bounds.x - step });
      break;
    case "right":
      mainWindow.setBounds({ ...bounds, x: bounds.x + step });
      break;
  }
}

let isRecording = false;
let audioChunks = [];
let micInstance;
const AUDIO_FILE_PATH = path.join(__dirname, "recorded_audio.wav");

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  audioChunks = [];

  micInstance = mic({
    rate: "16000",
    channels: "1",
    fileType: "wav",
  });

  const micInputStream = micInstance.getAudioStream();
  const outputFileStream = fs.createWriteStream(AUDIO_FILE_PATH);

  micInputStream.pipe(outputFileStream);

  micInputStream.on("error", (err) => {
    console.error("Mic error:", err);
  });

  micInstance.start();
  console.log("Recording started...");
}

async function stopRecording() {
  if (!isRecording || !micInstance) return;
  isRecording = false;

  micInstance.stop();
  console.log("Recording stopped.");

  // Ensure the file exists before sending to OpenAI
  if (!fs.existsSync(AUDIO_FILE_PATH)) {
    console.error("Error: Audio file not found!");
    return;
  }

  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(AUDIO_FILE_PATH),
      model: "whisper-1",
      response_format: "text",
    });

    const transcribedText = response;
    console.log("Transcribed Text:", transcribedText);

    mainWindow.webContents.send("transcription-result", transcribedText);

    // Send transcribed text for further processing
    const chatResponse = await openai.chat.completions.create({
      model: config.model,
      messages: [{ role: "user", content: transcribedText }],
      max_tokens: 5000,
    });

    mainWindow.webContents.send(
      "analysis-result",
      chatResponse.choices[0].message.content
    );
  } catch (err) {
    console.error("Error processing audio:", err);
    mainWindow.webContents.send("error", err.message);
  } finally {
    // Clean up the recorded file
    fs.unlinkSync(AUDIO_FILE_PATH);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    paintWhenInitiallyHidden: true,
    contentProtection: true,
    type: "toolbar",
  });

  mainWindow.loadFile("index.html");
  mainWindow.setContentProtection(true);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, "screen-saver", 1);

  // Screenshot functionality
  globalShortcut.register("CommandOrControl+Shift+S", async () => {
    try {
      const img = await captureScreenshot();
      screenshots.push(img);
      await processScreenshots();
    } catch (error) {
      console.error("Ctrl+Shift+S error:", error);
    }
  });

  // Multi-mode screenshot functionality
  globalShortcut.register("CommandOrControl+Shift+A", async () => {
    try {
      if (!multiPageMode) {
        multiPageMode = true;
        updateInstruction(
          "Multi-mode: Ctrl+Shift+A to add, Ctrl+Shift+S to finalize"
        );
      }
      const img = await captureScreenshot();
      screenshots.push(img);
      updateInstruction(
        "Multi-mode: Ctrl+Shift+A to add, Ctrl+Shift+S to finalize"
      );
    } catch (error) {
      console.error("Ctrl+Shift+A error:", error);
    }
  });

  // Reset process
  globalShortcut.register("CommandOrControl+Shift+R", () => {
    resetProcess();
  });

  // Quit application
  globalShortcut.register("CommandOrControl+Shift+Q", () => {
    console.log("Quitting application...");
    app.quit();
  });

  // Toggle window visibility (Ctrl + B / Cmd + B)
  globalShortcut.register("CommandOrControl+Shift+B", () => {
    toggleWindowVisibility();
  });

  // Move window (Ctrl + Arrow / Cmd + Arrow)
  globalShortcut.register("CommandOrControl+Shift+Up", () => moveWindow("up"));
  globalShortcut.register("CommandOrControl+Shift+Down", () =>
    moveWindow("down")
  );
  globalShortcut.register("CommandOrControl+Shift+Left", () =>
    moveWindow("left")
  );
  globalShortcut.register("CommandOrControl+Shift+Right", () =>
    moveWindow("right")
  );
  // Bind Ctrl+Shift+R to Start/Stop Recording
  globalShortcut.register("CommandOrControl+Shift+F", () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
