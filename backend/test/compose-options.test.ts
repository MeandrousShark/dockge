import assert from "node:assert/strict";
import { test } from "node:test";
import { getComposeOptions } from "../compose-options";

test("Compose options preserve the command and extra options without environment files", () => {
    const extraOptions = [ "--format", "json" ];

    assert.deepEqual(
        getComposeOptions("ps", extraOptions, false, false),
        [ "compose", "ps", "--format", "json" ],
    );
    assert.deepEqual(extraOptions, [ "--format", "json" ]);
});

test("Compose options retain Compose's default local .env behavior without global defaults", () => {
    assert.deepEqual(
        getComposeOptions("up", [ "-d", "--remove-orphans" ], false, true),
        [ "compose", "up", "-d", "--remove-orphans" ],
    );
});

test("Compose options place global defaults before the command", () => {
    assert.deepEqual(
        getComposeOptions("down", [ "--remove-orphans" ], true, false),
        [ "compose", "--env-file", "../global.env", "down", "--remove-orphans" ],
    );
});

test("Compose options apply a stack .env after global defaults", () => {
    assert.deepEqual(
        getComposeOptions("up", [ "-d", "--remove-orphans" ], true, true),
        [ "compose", "--env-file", "../global.env", "--env-file", "./.env", "up", "-d", "--remove-orphans" ],
    );
});
