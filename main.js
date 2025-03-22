const {
  app,
  BrowserWindow,
  globalShortcut,
  systemPreferences,
  ipcMain,
} = require("electron");
const path = require("path");
const screenshot = require("screenshot-desktop");
const fs = require("fs");
const { OpenAI } = require("openai");
const tmp = require("tmp");
systemPreferences.askForMediaAccess("microphone");
systemPreferences.askForMediaAccess("camera");

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
  updateInstructionBanner();
}

function updateInstructionBanner() {
  const instructions = [
    "Ctrl+Shift+S: Screenshot",
    "Ctrl+Shift+A: Multi-mode",
    "Ctrl+Shift+F: Record Audio",
    "Ctrl+Shift+C: Show Chat",
    "Ctrl+B: Toggle Hide",
    "Ctrl+Arrow: Control view",
    "Ctrl+Shift+Q: Close",
  ];

  updateInstruction(instructions.join("\n"));
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

// Audio recording state
let isRecording = false;

// Start the audio recording process
function startRecording() {
  if (isRecording) return;

  updateInstruction("Starting audio recording...");
  mainWindow.webContents.send("start-audio-recording");
  isRecording = true;
}

// Process the recorded audio
async function processAudio(audioBuffer) {
  try {
    // Create a temporary file for the audio data
    const tmpFile = tmp.fileSync({ postfix: ".webm" });
    fs.writeFileSync(tmpFile.name, Buffer.from(audioBuffer));

    updateInstruction("Processing audio...");

    // Send audio to OpenAI for transcription
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile.name),
      model: "whisper-1",
      response_format: "text",
    });

    const transcribedText = response || "";
    console.log("Transcribed Text:", transcribedText);

    if (!transcribedText.trim()) {
      throw new Error("Transcription failed: Received empty text.");
    }

    // Send the transcribed text to the renderer to display in the chat
    mainWindow.webContents.send("add-chat-message", {
      role: "user",
      content: transcribedText,
    });

    // Process transcribed text further
    const chatResponse = await openai.chat.completions.create({
      model: config.model,
      messages: [{ role: "user", content: transcribedText }],
      max_tokens: 5000,
    });

    const responseContent = chatResponse.choices[0].message.content;

    // Send the AI response to the renderer to display in the chat
    mainWindow.webContents.send("add-chat-message", {
      role: "assistant",
      content: responseContent,
    });

    // Also send to the analysis-result for the overlay display
    mainWindow.webContents.send("analysis-result", responseContent);

    // Cleanup temp file
    try {
      fs.unlinkSync(tmpFile.name);
      console.log("Temporary file deleted.");
    } catch (cleanupError) {
      console.error("Error deleting temp file:", cleanupError);
    }

    // Update instruction banner back to normal
    updateInstructionBanner();
  } catch (err) {
    console.error("Error processing audio:", err);
    mainWindow.webContents.send("error", err.message);
    updateInstructionBanner();
  }
}

// Stop the audio recording process
function stopRecording() {
  if (!isRecording) return;

  updateInstruction("Stopping audio recording...");
  mainWindow.webContents.send("stop-audio-recording");
  isRecording = false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
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

  // Bind Ctrl+Shift+F to Start/Stop Recording
  globalShortcut.register("CommandOrControl+Shift+F", () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  // Toggle chat visibility
  globalShortcut.register("CommandOrControl+Shift+C", () => {
    mainWindow.webContents.send("toggle-chat-visibility");
  });

  // IPC handlers for audio recording
  ipcMain.on("audio-data", (event, audioBuffer) => {
    processAudio(audioBuffer);
  });

  // Initialize the instruction banner
  updateInstructionBanner();
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
