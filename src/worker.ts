const fs = require('fs');
import * as path from "path";
import { ManageMessageType, ManagerMessage, WorkerMessageType } from "./protocol";

const { parserPlugins } = require('@istanbuljs/schema').defaults.nyc;
const { createInstrumenter } = require('istanbul-lib-instrument');
const { hookRequire } = require('istanbul-lib-hook');
let sigint = false;
process.on('SIGINT', function() {
  console.log('Received SIGINT. shutting down gracefully');
  sigint = true;
});

class Worker {
  private readonly fn: (buf: Buffer) => void;

  constructor(fn: (buf: Buffer) => void) {
    this.fn = fn;
  }

  checkTermination() {
    if (sigint) {
      process.exit(0);
    }
  }

  start() {
    setInterval(async () => {
      this.checkTermination();
    }, 1000);
    process.on('message', async (m: ManagerMessage) => {
      try {
        if (m.type === ManageMessageType.WORK) {
          this.checkTermination();
          // @ts-ignore
          let buffer = Buffer.from(m.buf.data);
          if (isAsyncFunction(this.fn)) {
            // @ts-ignore
            await this.fn(buffer);
          } else {
            // @ts-ignore
            this.fn(buffer);
          }
          process.send!({
            type: WorkerMessageType.RESULT,
            coverage: global.__coverage__
          })
        }
      } catch (e) {
        console.log("=================================================================");
        console.log(e);
        process.send!({
          type: WorkerMessageType.CRASH,
        });
        process.exit(1);
      }
    });
  }
}

function isAsyncFunction(fn: Function): fn is (...args: any[]) => Promise<any> {
  return fn.constructor.name === 'AsyncFunction';
}

const instrumenter = createInstrumenter({
  compact: false, cache: false, parserPlugins: parserPlugins.concat('typescript'), esModules: true, produceSourceMap: true
});
const fuzzTargetPath = path.join(process.cwd(), process.argv[2]);
const fuzzBaseDir = path.dirname(fuzzTargetPath);
// @ts-ignore
hookRequire((filePath) => {
  // let shouldHook = filePath.startsWith(fuzzBaseDir);
  // console.error("#0 HOOK Should hook", filePath, "?", shouldHook);
  return true;
},
  // @ts-ignore
  (code, { filename }) => {
    console.log("#0 HOOK", filename);
    let sourceMap = undefined;
    let sourceMapPath = filename + '.map';
    if (fs.existsSync(sourceMapPath)) {
      console.log("#0 SOURCEMAP", sourceMapPath);
      let sourceMap = JSON.parse(fs.readFileSync(sourceMapPath));
    }
    const newCode = instrumenter.instrumentSync(code, filename, sourceMap);
    return newCode;
  });


const fuzzTargetFn = require(fuzzTargetPath).fuzz;
if (typeof fuzzTargetFn !== "function") {
  throw new Error(`${fuzzTargetPath} has no fuzz function exported`);
}
const worker = new Worker(fuzzTargetFn);
worker.start();


