// @flow

// Copyright 2016 The Noms Authors. All rights reserved.
// Licensed under the Apache License, version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0

import {request} from 'http';
import {parse} from 'url';
import Bytes from './bytes.js';

export type FetchOptions = {
  method?: string,
  body?: any,
  headers?: {[key: string]: string},
  respHeaders?: string[],
  withCredentials? : boolean,
};

type TextResponse = {headers: Map<string, string>, buf: string}
type BufResponse = {headers: Map<string, string>, buf: Uint8Array}

function fetch(url: string, options: FetchOptions = {}): Promise<BufResponse> {
  const opts: any = parse(url);
  opts.method = options.method || 'GET';
  if (options.headers) {
    opts.headers = options.headers;
  }
  return new Promise((resolve, reject) => {
    const req = request(opts, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(res.statusCode);
        return;
      }

      let buf = Bytes.alloc(2048);
      let offset = 0;
      const ensureCapacity = (n: number) => {
        let length = buf.byteLength;
        if (offset + n <= length) {
          return;
        }

        while (offset + n > length) {
          length *= 2;
        }

        buf = Bytes.grow(buf, length);
      };

      res.on('data', (chunk: Uint8Array) => {
        const size = chunk.byteLength;
        ensureCapacity(size);
        Bytes.copy(chunk, buf, offset);
        offset += size;
      });
      res.on('end', () => {
        const headers = new Map();
        if (opts.respHeaders) {
          for (const header of opts.respHeaders) {
            headers.set(header, res.headers[header]);
          }
        }
        resolve({headers: headers, buf: Bytes.subarray(buf, 0, offset)});
      });
    });
    req.on('error', err => {
      reject(err);
    });
    // Set an idle-timeout of 2 minutes. The contract requires us to manually abort the connection,
    // then catch that event and report an error.
    req.setTimeout(2 * 60 * 1000, () => req.abort());
    req.on('abort', () => {
      reject(new Error('HTTP request timed out'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function arrayBufferToBuffer(ab: ArrayBuffer): Buffer {
  // $FlowIssue: Node type declaration doesn't include ArrayBuffer.
  return new Buffer(ab);
}

function bufferToString(buf: Uint8Array): string {
  return Bytes.readUtf8(buf, 0, buf.byteLength);
}

function normalizeBody(opts: FetchOptions): FetchOptions {
  if (opts.body instanceof ArrayBuffer) {
    opts.body = arrayBufferToBuffer(opts.body);
  }
  return opts;
}

export function fetchText(url: string, options: FetchOptions = {}): Promise<TextResponse> {
  return fetch(url, normalizeBody(options))
    .then(({headers, buf}) => ({headers: headers, buf: bufferToString(buf)}));
}

export function fetchUint8Array(url: string, options: FetchOptions = {}): Promise<BufResponse> {
  return fetch(url, options);
}
