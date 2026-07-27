import fs, { promises as fsAsync } from "fs";
import path from "path";
import { ValidationError } from "./validation-error";

/**
 * Validate a stack name before using it as part of a filesystem path.
 */
export function validateStackName(name : string) {
    if (!name.match(/^[a-z0-9_-]+$/)) {
        throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
    }
}

/**
 * Resolve a stack path and ensure it remains inside the configured stacks directory.
 */
export function resolveStackPath(stacksDir : string, name : string) : string {
    validateStackName(name);

    const resolvedStacksDir = path.resolve(stacksDir);
    const resolvedStackPath = path.resolve(resolvedStacksDir, name);
    const relativeStackPath = path.relative(resolvedStacksDir, resolvedStackPath);

    if (!relativeStackPath || relativeStackPath.startsWith(".." + path.sep) || path.isAbsolute(relativeStackPath)) {
        throw new ValidationError("Stack path must be inside the stacks directory");
    }

    return resolvedStackPath;
}

/**
 * Ensure an existing stack directory is a real directory contained by the
 * configured stacks directory, rather than a symbolic-link redirect.
 */
export async function validateExistingStackPath(stacksDir : string, stackPath : string) {
    const stat = await fsAsync.lstat(stackPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ValidationError("Stack path must be a regular directory");
    }

    const realStacksDir = await fsAsync.realpath(path.resolve(stacksDir));
    const realStackPath = await fsAsync.realpath(stackPath);
    const relativeStackPath = path.relative(realStacksDir, realStackPath);
    if (!relativeStackPath || relativeStackPath.startsWith(".." + path.sep) || path.isAbsolute(relativeStackPath)) {
        throw new ValidationError("Stack path must be inside the stacks directory");
    }
}

/**
 * Check that a managed stack file is a regular file and not a symbolic link.
 *
 * `lstat` deliberately observes dangling symlinks, which `access` and
 * `existsSync` would otherwise mistake for absent files.
 *
 * @returns whether the path exists as a regular file
 */
export function validateStackFile(filePath : string) : boolean {
    let stat : fs.Stats;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }
        throw error;
    }

    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ValidationError("Stack files must be regular files");
    }

    return true;
}
