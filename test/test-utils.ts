import * as FS from "fs/promises";
import * as Path from "path";
import * as OS from "os";

/**
 * Creates a unique temporary directory for testing using the system's temp directory
 * @param testName - Name of the test for the directory
 * @returns Absolute path to the created temporary directory
 */
export async function createTempDir(testName: string): Promise<string> {
  const tempDir = await FS.mkdtemp(Path.join(OS.tmpdir(), `libuild-test-${testName}-`));
  return tempDir;
}

/**
 * Safely removes a temporary directory
 * @param tempDir - Path to the temporary directory to remove
 */
export async function removeTempDir(tempDir: string): Promise<void> {
  try {
    await FS.rm(tempDir, {recursive: true, force: true});
  } catch (error) {
    // Ignore cleanup errors - temp dirs will be cleaned up by OS eventually
    console.warn(`Warning: Could not clean up temp directory ${tempDir}:`, error);
  }
}

export async function copyFixture(fixtureName: string, targetDir: string) {
  const fixtureDir = Path.join(__dirname, "fixtures", fixtureName);
  await FS.cp(fixtureDir, targetDir, {recursive: true});
}

export async function readJSON(filePath: string) {
  const content = await FS.readFile(filePath, "utf-8");
  return JSON.parse(content);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await FS.access(filePath);
    return true;
  } catch {
    return false;
  }
}
