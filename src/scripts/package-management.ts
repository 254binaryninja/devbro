import { generateText, generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeHistory } from "../helpers/history";
import { verboseLog } from "../helpers/logger";
import { XMLBuilder } from 'fast-xml-parser';

// Constants
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// Types
type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

interface SystemInfo {
  packageManager: PackageManager;
  nodeVersion: string;
  isNvm: boolean;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// XML Builder Configuration
const xmlBuilder = new XMLBuilder({
  format: true,
  indentBy: '  ',
  ignoreAttributes: false,
  suppressUnpairedNode: false,
  suppressBooleanAttributes: false,
  cdataPropName: '__cdata',
});

function createValidationPrompt(packages: string[]): string {
  const xmlObj = {
    'package-validator': {
      role: {
        '#text': 'You are a package name validator that checks if provided npm package names are valid and complete.'
      },
      rules: {
        rule: [
          'Package names must be complete (e.g., \'@storybook/react\' not just \'storybook\')',
          'Package names must follow npm naming conventions',
          'Package names should be commonly used in the npm ecosystem',
          'Respond in XML format only'
        ]
      },
      'output-format': {
        validation: {
          r: {
            '#text': 'VALID or INVALID'
          },
          reason: {
            '#text': 'Only if invalid, explain why'
          }
        }
      },
      examples: {
        example: [
          {
            input: {
              '#text': '["react", "@types/react"]'
            },
            validation: {
              r: {
                '#text': 'VALID'
              }
            }
          },
          {
            input: {
              '#text': '["storybook"]'
            },
            validation: {
              r: {
                '#text': 'INVALID'
              },
              reason: {
                '#text': 'Incomplete package name. Should be \'@storybook/react\' or similar specific Storybook package'
              }
            }
          }
        ]
      },
      'validate-packages': {
        packages: {
          '#text': JSON.stringify(packages)
        }
      }
    }
  };

  verboseLog("package-management.ts createValidationPrompt", xmlObj);

  return xmlBuilder.build(xmlObj);
}

function createSystemPrompt(packageJsonContent: string): string {
  const xmlObj = {
    'package-manager': {
      role: {
        '#text': 'You are a package management expert that helps users manage their Node.js project dependencies.'
      },
      rules: {
        critical_rules: {
          rule: [
            'ONLY suggest removing packages that are EXPLICITLY listed in the current package.json\'s dependencies or devDependencies',
            'NEVER suggest removing a package that is not present in the current package.json',
            'If asked to remove a package that doesn\'t exist in package.json, respond that it cannot be removed as it\'s not installed'
          ]
        },
        general_rules: {
          rule: [
            'Suggest installing packages as devDependencies when they are development tools',
            'Consider peer dependencies when suggesting packages',
            'Recommend commonly used and well-maintained packages',
            'Check for existing similar packages before suggesting new ones'
          ]
        }
      },
      context: {
        'package-json': {
          __cdata: packageJsonContent
        }
      },
      'output-format': {
        schema: {
          operations: {
            '#text': 'Array of package operations to perform'
          },
          analysis: {
            '#text': 'Explanation of the proposed changes and their impact'
          }
        },
        example: {
          operations: [
            {
              type: 'add',
              packages: ['@types/react'],
              reason: 'Adding TypeScript type definitions for React',
              dependencies: ['react']
            }
          ],
          analysis: 'Installing TypeScript type definitions for better development experience with React.'
        }
      }
    }
  };

  verboseLog("package-management.ts createSystemPrompt", xmlObj);

  return xmlBuilder.build(xmlObj);
}

// Schemas
export const packageOperationSchema = z.object({
  operations: z.array(
    z.object({
      type: z.enum(["add", "remove"]),
      packages: z.array(z.string()),
      reason: z.string(),
      dependencies: z.array(z.string()).optional(),
    })
  ),
  analysis: z.string(),
});

export type PackageOperation = z.infer<typeof packageOperationSchema>;

// System Information Functions
async function detectNodeVersion(): Promise<string> {
  const { stdout } = await execa("node", ["--version"]);
  return stdout.trim();
}

async function isNvmInstalled(): Promise<boolean> {
  try {
    await execa("command", ["-v", "nvm"]);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(
  projectPath: string
): Promise<PackageManager> {
  const lockFiles = {
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
    "pnpm-lock.yaml": "pnpm",
    "bun.lockb": "bun",
  } as const;

  for (const [file, manager] of Object.entries(lockFiles)) {
    if (existsSync(join(projectPath, file))) {
      return manager as PackageManager;
    }
  }

  return "npm"; // Default to npm if no lock file is found
}

async function getSystemInfo(projectPath: string): Promise<SystemInfo> {
  const [packageManager, nodeVersion, isNvm] = await Promise.all([
    detectPackageManager(projectPath),
    detectNodeVersion(),
    isNvmInstalled(),
  ]);

  return {
    packageManager,
    nodeVersion,
    isNvm,
  };
}

// Package Installation Functions
async function installPackages(
  packages: string[],
  projectPath: string,
  systemInfo: SystemInfo
): Promise<string> {
  const installCommands = {
    npm: ["install"],
    yarn: ["add"],
    pnpm: ["add"],
    bun: ["add"],
  };

  const command = systemInfo.packageManager;
  const args = [...installCommands[command], ...packages];

  const { stdout } = await execa(command, args, {
    cwd: projectPath,
    stdio: ["ignore", "pipe", "pipe"],
  });

  verboseLog("Package installation output:", stdout);
  return stdout;
}

// Package Validation Functions
async function validatePackageNames(
  packages: string[]
): Promise<{ isValid: boolean; reason?: string }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await generateText({
        model: anthropic("claude-3-5-haiku-20241022"),
        messages: [
          {
            role: "system",
            content: createValidationPrompt(packages),
          },
          {
            role: "user",
            content: `Validate these package names: ${JSON.stringify(packages)}`,
          },
        ],
      });

      const responseText = response.text.trim();
      verboseLog("Package validation response", responseText);

      // Look for <r>VALID</r> or <r>INVALID</r>
      const validMatch = responseText.match(/<r>([^<]+)<\/r>/);
      if (!validMatch) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        return { isValid: false, reason: "Invalid validation response format" };
      }

      const isValid = validMatch[1].trim() === "VALID";
      
      if (!isValid) {
        const reasonMatch = responseText.match(/<reason>([^<]+)<\/reason>/);
        const reason = reasonMatch ? reasonMatch[1].trim() : "Invalid package name(s)";
        
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        
        return { isValid: false, reason };
      }

      return { isValid: true };
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      throw error;
    }
  }

  return { isValid: false, reason: "Maximum validation attempts reached" };
}

// Package Operation Functions
export async function generatePackageOperations(
  request: string,
  packageJsonContent: string
): Promise<PackageOperation> {
  verboseLog("Generating package operations", { request });

  let packageJson: PackageJson = {};
  try {
    packageJson = JSON.parse(packageJsonContent);
  } catch (error) {
    throw new Error("Invalid package.json content");
  }

  try {
    const { object } = await generateObject({
      model: anthropic("claude-3-5-sonnet-20241022"),
      schema: packageOperationSchema,
      messages: [
        {
          role: "system",
          content: createSystemPrompt(packageJsonContent),
        },
        {
          role: "user",
          content: xmlBuilder.build({
            request: {
              'user-request': {
                '#text': request
              }
            }
          }),
        },
      ],
    });

    const operations = object;
    const installedPackages = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    // Filter out non-existent packages for removal operations
    operations.operations = operations.operations.map((operation) => {
      if (operation.type === "remove") {
        const validPackages = operation.packages.filter((pkg) => {
          const isInstalled = !!installedPackages[pkg];
          if (!isInstalled) {
            verboseLog(`Skipping removal of non-existent package: ${pkg}`);
          }
          return isInstalled;
        });

        return {
          ...operation,
          packages: validPackages,
        };
      }
      return operation;
    });

    // Remove operations with no valid packages
    operations.operations = operations.operations.filter((operation) => {
      if (operation.type === "remove" && operation.packages.length === 0) {
        log.info(`No valid packages to remove - they might not be installed`);
        return false;
      }
      return true;
    });

    if (operations.operations.length === 0) {
      log.info(
        "No valid operations to perform - the packages might not be installed"
      );
      return { operations: [], analysis: "No valid operations to perform" };
    }

    verboseLog("Generated package operations", operations);
    return operations;
  } catch (error) {
    verboseLog("Failed to generate package operations", error);
    throw error;
  }
}

export async function validateOperations(
  operations: PackageOperation["operations"]
): Promise<boolean> {
  verboseLog("Validating operations", operations);

  if (operations.length === 0) {
    return false;
  }
  

  for (const operation of operations) {
    const validation = await validatePackageNames(operation.packages);
    if (!validation.isValid) {
      log.warn(
        `Package validation warning for ${operation.type} operation: ${validation.reason}`
      );
      verboseLog("Operations validation result", { isValid: false });
      return false;
    }
  }
  verboseLog("Operations validation result", { isValid: true });
  return true;
}

export async function executePackageOperations(
  operations: PackageOperation["operations"]
): Promise<void> {
  verboseLog("Executing package operations", operations);
  const spin = spinner();
  const projectPath = process.cwd();

  if (operations.length === 0) {
    log.info("No valid operations to perform");
    return;
  }

  try {
    spin.start("Gathering system information");
    const systemInfo = await getSystemInfo(projectPath);
    spin.stop("System information gathered");

    // Read package.json once at the start
    const packageJsonPath = join(projectPath, "package.json");
    if (!existsSync(packageJsonPath)) {
      throw new Error("No package.json found in the current directory");
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const allDeps = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    };

    log.info(`Using ${systemInfo.packageManager} package manager`);
    log.info(`Node.js version: ${systemInfo.nodeVersion}`);

    for (const operation of operations) {
      verboseLog(`Executing operation: ${operation.type}`, operation);
      const packageList = operation.packages
        .map((pkg) => `'${pkg}'`)
        .join(", ");

      if (operation.type === "add") {
        // Check if packages are already installed
        const existingPackages = operation.packages.filter((pkg) => allDeps[pkg]);
        if (existingPackages.length === operation.packages.length) {
          log.info(`All packages are already installed: ${packageList}`);
          continue;
        }

        const newPackages = operation.packages.filter((pkg) => !allDeps[pkg]);
        if (newPackages.length > 0) {
          const installList = newPackages.map(pkg => `'${pkg}'`).join(", ");
          spin.start(`Installing new packages: ${installList}`);
          await installPackages(newPackages, projectPath, systemInfo);
          spin.stop("Packages installed successfully");
        }
      } else {
        // For removal operations
        const existingPackages = operation.packages.filter((pkg) => allDeps[pkg]);
        if (existingPackages.length === 0) {
          log.info(`No packages to remove - none of the specified packages are installed: ${packageList}`);
          continue;
        }

        const removeList = existingPackages.map(pkg => `'${pkg}'`).join(", ");
        spin.start(`Removing packages: ${removeList}`);
        const removeCommand = systemInfo.packageManager === "yarn" ? "remove" : "uninstall";
        const result = await execa(
          systemInfo.packageManager,
          [removeCommand, ...existingPackages],
          {
            cwd: projectPath,
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

        verboseLog("Package removal output:", result.stdout);
        spin.stop("Packages removed successfully");
      }

      writeHistory({
        op: `package-${operation.type}`,
        d: operation.reason || `${operation.type === 'add' ? 'Added' : 'Removed'} packages: ${packageList}`,
        data: {
          packages: operation.packages,
          type: operation.type,
          packageManager: systemInfo.packageManager,
          nodeVersion: systemInfo.nodeVersion,
          dependencies: operation.dependencies || []
        }
      });
    }

  } catch (error: any) {
    spin.stop(
      `Failed to execute package operations: ${error?.message || "Unknown error"}`
    );
    throw error;
  }
}
