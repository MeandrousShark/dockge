import assert from "node:assert/strict";
import { test } from "node:test";
import {
    parseComposeListOutput,
    parseComposePsOutput,
    parseContainerPsOutput,
    parseNetworkListOutput,
    parseStatsOutput,
} from "../container-engine/output-parser";

test("Compose list output accepts a JSON array", () => {
    const output = "[\n  { \"Name\": \"demo\", \"Status\": \"running(1)\" },\n  { \"Name\": \"paused\", \"Status\": \"exited(1)\" }\n]";

    assert.deepEqual(parseComposeListOutput(output), [
        { Name: "demo",
            Status: "running(1)" },
        { Name: "paused",
            Status: "exited(1)" },
    ]);
});

test("Compose list output rejects malformed overall non-array payloads", () => {
    assert.deepEqual(parseComposeListOutput("{ \"Name\": \"demo\", \"Status\": \"running(1)\" }"), []);
    assert.deepEqual(parseComposeListOutput("{ \"Name\": \"demo\", \"Status\": \"running(1)\" }\n{ \"Name\": \"other\", \"Status\": \"running(1)\" }"), []);
});

test("Compose ps output accepts both JSON array and newline-delimited JSON", () => {
    const rows = [
        { Service: "web",
            State: "running",
            Name: "demo-web-1",
            Health: "healthy" },
        { Service: "worker",
            State: "exited",
            Name: "demo-worker-1",
            Health: "" },
    ];

    assert.deepEqual(parseComposePsOutput(JSON.stringify(rows)), rows);
    assert.deepEqual(parseComposePsOutput(rows.map((row) => JSON.stringify(row)).join("\n")), rows);
});

test("direct container ps output accepts newline-delimited JSON", () => {
    const rows = [
        { ID: "abc123",
            Names: "demo-web-1",
            Status: "Up 2 minutes" },
        { ID: "def456",
            Names: "demo-worker-1",
            Status: "Exited (0) 1 minute ago" },
    ];

    assert.deepEqual(parseContainerPsOutput(rows.map((row) => JSON.stringify(row)).join("\n")), rows);
});

test("network output removes blank lines and sorts names", () => {
    assert.deepEqual(parseNetworkListOutput("zebra\n\n  \nalpha\n\t\nmidway\n"), [
        "alpha",
        "midway",
        "zebra",
    ]);
});

test("stats output accepts newline-delimited JSON and keys entries by name", () => {
    const web = { Container: "abc123",
        ID: "abc123",
        Name: "demo-web-1",
        CPUPerc: "0.42%",
        MemUsage: "12MiB / 1GiB" };
    const worker = { Name: "demo-worker-1",
        CPUPerc: "0.00%",
        MemUsage: "8MiB / 1GiB" };

    assert.deepEqual(
        parseStatsOutput(`${JSON.stringify(web)}\n${JSON.stringify(worker)}\n`),
        new Map([
            [ web.Name, web ],
            [ worker.Name, worker ],
        ]),
    );
});

test("output parsers safely ignore empty output and malformed individual lines", () => {
    const composeRow = { Service: "web",
        State: "running",
        Name: "demo-web-1",
        Health: "" };
    const containerRow = { ID: "abc123",
        Names: "demo-web-1",
        Status: "Up 2 minutes" };
    const statsRow = { Name: "demo-web-1",
        CPUPerc: "0.42%" };

    assert.deepEqual(parseComposeListOutput(""), []);
    assert.deepEqual(parseComposeListOutput("not json"), []);
    assert.deepEqual(parseComposePsOutput(""), []);
    assert.deepEqual(parseComposePsOutput(`${JSON.stringify(composeRow)}\nnot json\nnull`), [ composeRow ]);
    assert.deepEqual(parseContainerPsOutput(""), []);
    assert.deepEqual(parseContainerPsOutput(`${JSON.stringify(containerRow)}\nnot json\n[]`), [ containerRow ]);
    assert.deepEqual(parseNetworkListOutput("\n \n\t\n"), []);
    assert.deepEqual(parseStatsOutput(""), new Map());
    assert.deepEqual(parseStatsOutput(`${JSON.stringify(statsRow)}\nnot json\nnull`), new Map([[ statsRow.Name, statsRow ]]));
});
