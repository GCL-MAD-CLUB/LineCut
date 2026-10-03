import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/systems/TaskSystem/TaskSystem.tsx", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Exercise the actual TaskSystem API and promises; only rendering and reporting
// are stubbed, so these tests require neither a browser nor a native backend.
function taskSystem() {
  const errors = [];
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  runInNewContext(compiled, {
    exports,
    require: (name) => {
      if (name === "react") {
        return { useMemo: (build) => build(), useSyncExternalStore: (_, snapshot) => snapshot() };
      }
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "lucide-react" || name.endsWith(".css")) return {};
      if (name === "../../errors") {
        return { captureOperationError: (...args) => errors.push(args) };
      }
      assert.fail(`Unexpected dependency: ${name}`);
    },
  });
  return { ...exports, errors };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function options(label, listener, on_cancel, operation = "storyboard.detect") {
  return { label, resourceKey: label, operation, current: 0, total: 1, listener, on_cancel };
}
function states(system) {
  return Object.fromEntries(
    system.useTaskProgressStatus().tasks.map((task) => [task.label, task.state]),
  );
}

test("starts three native owners concurrently and refills on out-of-order completion or failure", async () => {
  const system = taskSystem();
  const started = [];
  const cleaned = [];
  const publishers = {};
  const jobs = Array.from({ length: 6 }, (_, index) =>
    system.createTaskProgress(
      options(String(index), (publish) => {
        started.push(index);
        publishers[index] = publish;
        return () => cleaned.push(index);
      }),
    ),
  );
  await flush();
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(states(system), {
    0: "running",
    1: "running",
    2: "running",
    3: "queued",
    4: "queued",
    5: "queued",
  });
  const first = await Promise.all(jobs.slice(0, 3));
  publishers[0]({ current: 0.25 });
  publishers[2]({ current: 0.75 });
  const views = system.useTaskProgressStatus().tasks;
  assert.equal(views[0].percent, 25);
  assert.equal(views[1].percent, 0);
  assert.equal(views[2].percent, 75);
  first[1].remove();
  const fourth = await jobs[3];
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(states(system)[3], "running");
  assert.equal(states(system)[4], "queued");
  first[2].fail({ code: "STORYBOARD_INFERENCE_FAILED" });
  const fifth = await jobs[4];
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(system.errors.length, 1);
  first[0].remove();
  const sixth = await jobs[5];
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  fourth.remove();
  fifth.remove();
  sixth.remove();
  await flush();
  assert.equal(system.useTaskProgressStatus().count, 0);
  assert.deepEqual(cleaned.sort(), [0, 1, 2, 3, 4, 5]);
});

test("cancelling a running detection holds its slot until its backend settles", async () => {
  const system = taskSystem();
  const cancellation = deferred();
  const started = [];
  const jobs = Array.from({ length: 4 }, (_, index) =>
    system.createTaskProgress(
      options(
        String(index),
        () => {
          started.push(index);
        },
        () => cancellation.promise,
      ),
    ),
  );
  const handles = await Promise.all(jobs.slice(0, 3));
  const cancelling = system.useTaskProgressStatus().tasks[1].cancel();
  await flush();
  assert.equal(handles[1].cancelled, true);
  assert.deepEqual(started, [0, 1, 2]);
  cancellation.resolve();
  await cancelling;
  assert.deepEqual(started, [0, 1, 2]);
  handles[1].remove();
  const replacement = await jobs[3];
  assert.deepEqual(started, [0, 1, 2, 3]);
  handles[0].remove();
  handles[2].remove();
  replacement.remove();
});

test("queued cancellation never starts native work and does not disturb running tasks", async () => {
  const system = taskSystem();
  const started = [];
  let backendCancels = 0;
  const jobs = Array.from({ length: 5 }, (_, index) =>
    system.createTaskProgress(
      options(
        String(index),
        () => {
          started.push(index);
        },
        () => {
          backendCancels += 1;
        },
      ),
    ),
  );
  const first = await Promise.all(jobs.slice(0, 3));
  await system.useTaskProgressStatus().tasks[3].cancel();
  assert.equal((await jobs[3]).cancelled, true);
  assert.equal(backendCancels, 0);
  assert.deepEqual(started, [0, 1, 2]);
  first[0].remove();
  const replacement = await jobs[4];
  assert.deepEqual(started, [0, 1, 2, 4]);
  first[1].remove();
  first[2].remove();
  replacement.remove();
});

test("cancel-all prevents refill and resumes newly submitted work after all owners settle", async () => {
  const system = taskSystem();
  const gate = deferred();
  const started = [];
  const handles = [];
  const jobs = Array.from({ length: 5 }, (_, index) =>
    system.createTaskProgress(
      options(
        String(index),
        () => {
          started.push(index);
        },
        async () => {
          await gate.promise;
          handles[index].remove();
        },
      ),
    ),
  );
  handles.push(...(await Promise.all(jobs.slice(0, 3))));
  const cancelling = system.cancelAllTaskProgress();
  const later = system.createTaskProgress(
    options("later", () => {
      started.push("later");
    }),
  );
  await flush();
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal((await jobs[3]).cancelled, true);
  assert.equal((await jobs[4]).cancelled, true);
  assert.equal(states(system).later, "queued");
  gate.resolve();
  await cancelling;
  const next = await later;
  assert.deepEqual(started, [0, 1, 2, "later"]);
  next.remove();
});

test("other operations retain exclusive FIFO execution between storyboard batches", async () => {
  const system = taskSystem();
  const started = [];
  const jobs = ["storyboard.detect", "storyboard.detect", "media.analyze", "storyboard.detect"].map(
    (operation, index) =>
      system.createTaskProgress(
        options(
          String(index),
          () => {
            started.push(index);
          },
          undefined,
          operation,
        ),
      ),
  );
  const first = await Promise.all(jobs.slice(0, 2));
  assert.deepEqual(started, [0, 1]);
  first[0].remove();
  await flush();
  assert.deepEqual(started, [0, 1]);
  first[1].remove();
  const exclusive = await jobs[2];
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(states(system)[3], "queued");
  exclusive.remove();
  const next = await jobs[3];
  assert.deepEqual(started, [0, 1, 2, 3]);
  next.remove();
});
