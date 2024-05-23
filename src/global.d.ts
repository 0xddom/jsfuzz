
export interface global { }
declare global {
  var __coverage__: {
    [filePath: string]: {
      s: { [n: string]: number };
      f: { [n: string]: number };
      b: { [n: string]: number[] };
    };
  };
}

