import puppeteer from "puppeteer";
import type { Browser, LaunchOptions } from "puppeteer";

let browserInstance: Browser | null = null;

/**
 * Gets the launch options for Puppeteer, including platform-specific executable path.
 */
const getLaunchOptions = (): LaunchOptions => {
  // Default options
  const options: LaunchOptions = {
    headless: true, // Keep headless as default
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    timeout: 60000, // 60 second timeout
  };

  // Use installed Chrome on Apple Silicon Macs if available
  if (process.platform === "darwin" && process.arch === "arm64") {
    // A more robust check could verify file existence, but this matches previous logic
    options.executablePath =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  return options;
};

/**
 * Retrieves a shared Puppeteer browser instance.
 * If an instance doesn't exist or is disconnected, it launches a new one.
 * @returns A promise that resolves to the Puppeteer Browser instance.
 */
export const getBrowserInstance = async (): Promise<Browser> => {
  // Check if instance exists and is still connected
  if (!browserInstance || !browserInstance.isConnected()) {
    if (browserInstance) {
      console.log(
        "Existing browser instance disconnected. Launching new one..."
      );
      // Attempt cleanup just in case
      try {
        await browserInstance.close();
      } catch {}
    }
    console.log("Launching shared browser instance...");
    browserInstance = await puppeteer.launch(getLaunchOptions());
    console.log("Shared browser instance launched successfully.");

    // Optional: Add listener for unexpected disconnects
    browserInstance.on("disconnected", () => {
      console.warn("Shared browser instance disconnected unexpectedly.");
      browserInstance = null;
    });
  }
  return browserInstance;
};

/**
 * Closes the shared Puppeteer browser instance if it exists.
 */
export const closeBrowserInstance = async (): Promise<void> => {
  if (browserInstance?.isConnected()) {
    console.log("Closing shared browser instance...");
    await browserInstance.close();
    browserInstance = null;
    console.log("Shared browser instance closed.");
  } else if (browserInstance) {
    console.log("Shared browser instance already closed or disconnected.");
    browserInstance = null; // Ensure it's nullified
  }
};
