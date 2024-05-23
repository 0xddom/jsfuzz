// const cp = require('child_process');
import { Corpus } from "./corpus";
import * as fs from "fs";
import { ChildProcess, fork } from "child_process";
import { ManageMessageType, WorkerMessage, WorkerMessageType } from "./protocol";
import { BuildVerse, Verse } from "./versifier";

const crypto = require('crypto');
const util = require('util');
const pidusage = require('pidusage');
process.on('SIGINT', function() {
  // ignore sigint as this propagates to worker as well.
  console.log('Received SIGINT. shutting down gracefully');
});


export class Fuzzer {
  private corpus: Corpus;
  private total_executions: number;
  private total_coverage: number;
  private exactArtifactPath: string;
  private rssLimitMb: number;
  private timeout: number;
  private fuzzTime: number;
  private target: string;
  private startTime: number;
  private startTimeOneSample: number;
  private worker: ChildProcess;
  private workerRss: number;
  private rssInterval: NodeJS.Timeout | null;
  private pulseInterval: NodeJS.Timeout | null;

  private lastSampleTime: number;
  private executionsInSample: number;
  private readonly regression: boolean;
  private verse: Verse | null;
  private readonly versifier: boolean;
  private readonly onlyAscii: boolean;
  private buf: Buffer;

  constructor(target: string,
    dir: string[],
    exactArtifactPath: string,
    rssLimitMb: number,
    timeout: number,
    regression: boolean,
    onlyAscii: boolean,
    versifier: boolean,
    fuzzTime: number) {
    this.target = target;
    this.corpus = new Corpus(dir, onlyAscii);
    this.onlyAscii = onlyAscii;
    this.versifier = versifier;
    this.verse = null;
    this.total_executions = 0;
    this.total_coverage = 0;
    this.exactArtifactPath = exactArtifactPath;
    this.rssLimitMb = rssLimitMb;
    this.timeout = timeout;
    this.fuzzTime = fuzzTime;
    this.startTime = Date.now();
    this.startTimeOneSample = Date.now();
    this.regression = regression;
    this.worker = fork(`${__dirname}/worker.js`,
      [this.target],
      { execArgv: [`--max-old-space-size=${this.rssLimitMb}`] });
    this.workerRss = 0;
    this.rssInterval = null;
    this.pulseInterval = null;
    this.lastSampleTime = Date.now();
    this.executionsInSample = 0;
    this.buf = Buffer.alloc(0);
  }

  logStats(type: string) {
    const rss = Math.trunc((process.memoryUsage().rss + this.workerRss) / 1024 / 1024 * 100) / 100;

    const endTime = Date.now();
    const execs_per_second = Math.trunc(this.executionsInSample / (endTime - this.lastSampleTime) * 1000);
    this.lastSampleTime = Date.now();
    this.executionsInSample = 0;

    console.log(`#${this.total_executions} ${type}     cov: ${this.total_coverage} corp: ${this.corpus.getLength()} exec/s: ${execs_per_second} rss: ${rss} MB`);
  }

  writeCrash() {
    let filepath = 'crash-' + crypto.createHash('sha256').update(this.buf).digest('hex');
    if (this.exactArtifactPath) {
      filepath = this.exactArtifactPath;
    }
    fs.writeFileSync(filepath, this.buf);
    console.log(`crash was written to ${filepath}`);
    if (this.buf.length < 200) {
      console.log(`crash(hex)=${this.buf.toString('hex')}`)
    }
  }

  clearIntervals() {
    if (this.rssInterval) {
      clearInterval(this.rssInterval);
      this.rssInterval = null;
    }
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
    pidusage.clear();
  }

  start() {
    this.prepare();
    if (this.regression) {
      this.doRegression();
    } else {
      this.fuzz();
    }
  }

  prepare() {
    console.log(`#0 READ units: ${this.corpus.getLength()}`);

    this.worker.on('error', (e: any) => {
      console.log('error received');
      console.log(e);
    });

    this.worker.on('exit', (code, signal) => {
      if (signal && code !== 0) {
        console.log('Worker killed');
        this.writeCrash();
        process.exitCode = 1;
      }
      console.log('Worker exited');
      this.clearIntervals();
    });

    this.pulseInterval = setInterval(() => {

      this.logStats("PULSE");

      // check fuzzTime and will sent SIGINT signal if time of fuzzing is reached
      if (this.fuzzTime !== 0) {
        let execTime = Date.now() / 1000 - this.startTime / 1000;
        if (execTime > this.fuzzTime) {
          console.log("=================================================================");
          console.log(`timeout of fuzzing is reached. Coverage has reached: ${this.total_coverage}`);
          this.worker.kill('SIGINT');
        }
      }
    }, 3000);

    this.rssInterval = setInterval(async () => {
      const stats = await pidusage(this.worker.pid);
      this.workerRss = stats.memory;
      if (this.workerRss > this.rssLimitMb * 1024 * 1024) {
        this.clearIntervals();
        console.log(`MEMORY OOM: exceeded ${this.rssLimitMb} MB. Killing worker`);
        this.worker.kill('SIGKILL');
      }

      const diffOneSample = Date.now() - this.startTimeOneSample;
      if ((diffOneSample / 1000) > this.timeout) {
        console.log("=================================================================");
        console.log(`timeout reached. testcase took: ${diffOneSample}`);
        this.worker.kill('SIGKILL');
        return;
      }
    }, 3000);
  }

  doRegression() {
    this.workQueue(() => this.corpus.shift());
  }

  sendWork(nextInput: () => Buffer | undefined) {
    let buf = nextInput();
    if (buf !== undefined) {
      this.buf = buf;
      this.worker.send({
        type: ManageMessageType.WORK,
        buf: this.buf
      });
    }
  }

  fuzz() {
    this.workQueue(() => {
      if (this.total_executions === 0) {
        return this.corpus.generateInput();
      }
      if (this.total_executions % 10 != 0 || this.verse === null || !this.versifier) {
        return this.corpus.generateInput();
      } else {
        return this.verse.Rhyme();
      }
    });
  }

  workQueue(nextInput: () => Buffer | undefined) {
    this.startTime = Date.now();
    this.lastSampleTime = Date.now();
    let executions = 0;

    this.startTimeOneSample = Date.now();
    this.worker.on('message', (m: WorkerMessage) => {
      this.total_executions++;
      this.executionsInSample++;
      const endTimeOneSample = Date.now();
      const diffOneSample = endTimeOneSample - this.startTimeOneSample;
      this.startTimeOneSample = endTimeOneSample;

      if (m.type === WorkerMessageType.CRASH) {
        this.writeCrash();
        this.clearIntervals();
        process.exitCode = 1;
        return;
      } else if (m.coverage > this.total_coverage) {

        // begin new time if cov has changed
        if (this.fuzzTime != 0) {
          this.startTime = Date.now();
        }
        this.total_coverage = m.coverage;
        this.corpus.putBuffer(this.buf);
        this.logStats('NEW');

        if (this.buf.length > 0 && this.versifier) {
          this.verse = BuildVerse(this.verse, this.buf);
        }
      } else if ((diffOneSample / 1000) > this.timeout) {
        console.log("=================================================================");
        console.log(`timeout reached. testcase took: ${diffOneSample}`);
        this.worker.kill('SIGKILL');
        return;
      }
      this.sendWork(nextInput);
    });

    this.sendWork(nextInput);
  }
}

