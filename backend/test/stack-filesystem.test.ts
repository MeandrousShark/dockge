import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ValidationError } from "../validation-error";
import {
    resolveStackPath,
    validateExistingStackPath,
    validateStackFile,
    validateStackName,
} from "../stack-filesystem";

function assertValidationError(callback : () => unknown) {
    assert.throws(callback, ValidationError);
}

async function createTemporaryDirectory() {
    return await mkdtemp(path.join(tmpdir(), "dockge-stack-filesystem-"));
}

test("stack names only accept simple lowercase path components", () => {
    for (const name of [ "app", "app_2", "app-2" ]) {
        assert.doesNotThrow(() => validateStackName(name));
    }

    for (const name of [ "", ".", "..", "../escape", "/tmp/escape", "nested/name", "nested\\name", "UPPER", "has space" ]) {
        assertValidationError(() => validateStackName(name));
    }
});

test("resolved stack paths remain inside the configured stacks directory", async (t) => {
    const temporaryDirectory = await createTemporaryDirectory();
    const stacksDirectory = path.join(temporaryDirectory, "stacks");
    await mkdir(stacksDirectory);
    t.after(async () => await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    }));

    assert.equal(resolveStackPath(stacksDirectory, "my-stack"), path.join(stacksDirectory, "my-stack"));
    assertValidationError(() => resolveStackPath(stacksDirectory, "../escape"));
    assertValidationError(() => resolveStackPath(stacksDirectory, "/tmp/escape"));
});

test("existing stack paths must be real directories contained by the stacks directory", async (t) => {
    const temporaryDirectory = await createTemporaryDirectory();
    const stacksDirectory = path.join(temporaryDirectory, "stacks");
    const regularStackDirectory = path.join(stacksDirectory, "regular");
    const regularFile = path.join(stacksDirectory, "not-a-directory");
    await mkdir(regularStackDirectory, { recursive: true });
    await writeFile(regularFile, "not a stack directory");
    t.after(async () => await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    }));

    await assert.doesNotReject(validateExistingStackPath(stacksDirectory, regularStackDirectory));
    await assert.rejects(validateExistingStackPath(stacksDirectory, regularFile), ValidationError);
});

test("stack directory symlinks are rejected", async (t) => {
    const temporaryDirectory = await createTemporaryDirectory();
    const stacksDirectory = path.join(temporaryDirectory, "stacks");
    const outsideDirectory = path.join(temporaryDirectory, "outside");
    const symlinkPath = path.join(stacksDirectory, "redirect");
    await mkdir(stacksDirectory);
    await mkdir(outsideDirectory);
    t.after(async () => await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    }));

    try {
        await symlink(outsideDirectory, symlinkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") {
            t.skip("The current platform does not permit test symlink creation");
            return;
        }
        throw error;
    }

    await assert.rejects(validateExistingStackPath(stacksDirectory, symlinkPath), ValidationError);
});

test("managed stack files must be regular files", async (t) => {
    const temporaryDirectory = await createTemporaryDirectory();
    const regularFile = path.join(temporaryDirectory, "compose.yaml");
    const directoryPath = path.join(temporaryDirectory, "directory");
    const missingFile = path.join(temporaryDirectory, "missing.yaml");
    await writeFile(regularFile, "services: {}\n");
    await mkdir(directoryPath);
    t.after(async () => await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    }));

    assert.equal(validateStackFile(regularFile), true);
    assert.equal(validateStackFile(missingFile), false);
    assertValidationError(() => validateStackFile(directoryPath));
});

test("managed stack file symlinks, including dangling symlinks, are rejected", async (t) => {
    const temporaryDirectory = await createTemporaryDirectory();
    const regularFile = path.join(temporaryDirectory, "compose.yaml");
    const fileSymlink = path.join(temporaryDirectory, "compose-link.yaml");
    const danglingSymlink = path.join(temporaryDirectory, "missing-link.yaml");
    await writeFile(regularFile, "services: {}\n");
    t.after(async () => await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    }));

    try {
        await symlink(regularFile, fileSymlink, "file");
        await symlink(path.join(temporaryDirectory, "does-not-exist.yaml"), danglingSymlink, "file");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") {
            t.skip("The current platform does not permit test symlink creation");
            return;
        }
        throw error;
    }

    assertValidationError(() => validateStackFile(fileSymlink));
    assertValidationError(() => validateStackFile(danglingSymlink));
});
