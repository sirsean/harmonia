import * as path from "path";
import * as fs from "fs";

/**
 * Deployment file structure
 */
export interface Deployment {
  address: string;
  abi: any[];
}

/**
 * Deployment names that can be loaded
 */
export type DeploymentName = "Reader" | "EventEmitter";

/**
 * Get the path to the deployments directory
 * This abstracts away the actual location from calling code
 */
function getDeploymentsDir(): string {
  // Deployments are stored relative to the project root
  // This works whether called from scripts/, src/, or test/
  const projectRoot = process.cwd();
  return path.join(projectRoot, "deployments");
}

/**
 * Get the path to a specific deployment file
 */
function getDeploymentPath(name: DeploymentName, network: string = "arbitrum"): string {
  const deploymentsDir = getDeploymentsDir();
  return path.join(deploymentsDir, `${name}.${network}.json`);
}

/**
 * Load a deployment file
 * @param name - Name of the deployment (e.g., "Reader", "EventEmitter")
 * @param network - Network name (default: "arbitrum")
 * @returns Deployment object with address and abi
 * @throws Error if deployment file not found
 */
export function loadDeployment(name: DeploymentName, network: string = "arbitrum"): Deployment {
  const deploymentPath = getDeploymentPath(name, network);

  try {
    if (!fs.existsSync(deploymentPath)) {
      throw new Error(
        `Deployment file not found: ${deploymentPath}. Please ensure the deployment file exists.`
      );
    }

    const content = fs.readFileSync(deploymentPath, "utf-8");
    const deployment = JSON.parse(content) as Deployment;

    if (!deployment.address || !deployment.abi) {
      throw new Error(`Invalid deployment file format: ${deploymentPath}`);
    }

    return deployment;
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      throw error;
    }
    throw new Error(
      `Failed to load deployment ${name} for network ${network}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load Reader deployment
 * Convenience function for the most common deployment
 */
export function loadReaderDeployment(network: string = "arbitrum"): Deployment {
  return loadDeployment("Reader", network);
}

/**
 * Load EventEmitter deployment
 * Convenience function for event emitter deployment
 */
export function loadEventEmitterDeployment(network: string = "arbitrum"): Deployment {
  return loadDeployment("EventEmitter", network);
}
