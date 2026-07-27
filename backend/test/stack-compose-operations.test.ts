import assert from "node:assert/strict";
import { test } from "node:test";
import { getStackComposeOptions } from "../stack-compose-operations";
import type { StackComposeOperation } from "../stack-compose-operations";

interface OperationCase {
    name: string;
    operation: StackComposeOperation;
    operationArguments?: string[];
    expected: string[];
}

const operationCases: OperationCase[] = [
    {
        name: "stack ps",
        operation: "stack-ps",
        expected: [ "ps", "--format", "json" ],
    },
    {
        name: "deploy",
        operation: "deploy",
        expected: [ "up", "-d", "--remove-orphans" ],
    },
    {
        name: "delete",
        operation: "delete",
        expected: [ "down", "--remove-orphans" ],
    },
    {
        name: "force delete",
        operation: "force-delete",
        expected: [ "down", "-v", "--remove-orphans" ],
    },
    {
        name: "start",
        operation: "start",
        expected: [ "up", "-d", "--remove-orphans" ],
    },
    {
        name: "stop",
        operation: "stop",
        expected: [ "stop" ],
    },
    {
        name: "restart",
        operation: "restart",
        expected: [ "restart" ],
    },
    {
        name: "down",
        operation: "down",
        expected: [ "down" ],
    },
    {
        name: "update pull",
        operation: "update-pull",
        expected: [ "pull" ],
    },
    {
        name: "update redeploy",
        operation: "update-redeploy",
        expected: [ "up", "-d", "--remove-orphans" ],
    },
    {
        name: "combined logs",
        operation: "combined-logs",
        expected: [ "logs", "-f", "--tail", "100" ],
    },
    {
        name: "container exec",
        operation: "container-exec",
        operationArguments: [ "app", "sh" ],
        expected: [ "exec", "app", "sh" ],
    },
    {
        name: "service status",
        operation: "service-status",
        expected: [ "ps", "--format", "json" ],
    },
    {
        name: "start service",
        operation: "start-service",
        operationArguments: [ "app" ],
        expected: [ "up", "-d", "app" ],
    },
    {
        name: "stop service",
        operation: "stop-service",
        operationArguments: [ "app" ],
        expected: [ "stop", "app" ],
    },
    {
        name: "restart service",
        operation: "restart-service",
        operationArguments: [ "app" ],
        expected: [ "restart", "app" ],
    },
];

for (const operationCase of operationCases) {
    test(`Stack ${operationCase.name} preserves global and local environment arguments`, () => {
        assert.deepEqual(
            getStackComposeOptions(operationCase.operation, operationCase.operationArguments || [], true, true),
            [ "compose", "--env-file", "../global.env", "--env-file", "./.env", ...operationCase.expected ],
        );
    });
}
