// @flow

// Copyright 2016 Attic Labs, Inc. All rights reserved.
// Licensed under the Apache License, version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0

import * as Bytes from './bytes.js';
import BuzHash from './buzhash.js';
import Hash from './hash.js';
import ValueEncoder from './value-encoder.js';
import type Value from './value.js';
import type {Type} from './type.js';
import {floatToIntExp} from './number-util.js';
import {invariant} from './assert.js';
import {maxUint32} from './binary-rw.js';
import {encode as encodeVarint, encodingLength as varintEncodingLength} from './signed-varint.js';

const defaultChunkPattern = ((1 << 12) | 0) - 1; // Avg Chunk Size of 4k

// The window size to use for computing the rolling hash. This is way more than neccessary assuming
// random data (two bytes would be sufficient with a target chunk size of 4k). The benefit of a
// larger window is it allows for better distribution on input with lower entropy. At a target
// chunk size of 4k, any given byte changing has roughly a 1.5% chance of affecting an existing
// boundary, which seems like an acceptable trade-off.
const defaultChunkWindow = 64;

export let chunkPattern = defaultChunkPattern;
export let chunkWindow = defaultChunkWindow;

const varintBuff = Bytes.alloc(10);

export function smallTestChunks() {
  chunkPattern = ((1 << 7) | 0) - 1; // Avg Chunk Size of 128 bytes
  chunkWindow = 32;
}

export function normalProductionChunks() {
  chunkPattern = defaultChunkPattern;
  chunkWindow = defaultChunkWindow;
}

export function hashValueBytes(item: Value, rv: RollingValueHasher) {
  rv.hashValue(item);
}

export function hashValueByte(b: number, rv: RollingValueHasher) {
  rv.hashByte(b);
}

export default class RollingValueHasher {
  bz: BuzHash;
  enc: ValueEncoder;
  bytesHashed: number;
  lengthOnly: boolean;
  crossedBoundary: boolean;
  pattern: number;
  window: number;

  constructor() {
    this.bz = new BuzHash(chunkWindow);
    this.enc = new ValueEncoder(this, null);
    this.bytesHashed = 0;
    this.crossedBoundary = false;
    this.pattern = chunkPattern;
    this.window = chunkWindow;
  }

  hashByte(b: number) {
    this.bytesHashed++;
    if (this.lengthOnly) {
      return;
    }

    this.bz.hashByte(b);
    this.crossedBoundary =
        this.crossedBoundary || ((this.bz.sum32 & this.pattern) | 0) === this.pattern;
  }

  clearLastBoundary() {
    this.crossedBoundary = false;
    this.bytesHashed = 0;
  }

  hashValue(v: Value) {
    this.enc.writeValue(v);
  }

  // NomsWriter interface. Note: It's unfortunate to have another implimentation of nomsWriter and
  // this one must be kept in sync with binaryNomsWriter, but hashing values is a red-hot code path
  // and it's worth alot to avoid the allocations for literally encoding values.
  writeBytes(v: Uint8Array): void {
    for (let i = 0; i < v.byteLength; i++) {
      this.hashByte(v[i]);
    }
  }

  writeUint8(v: number): void {
    this.hashByte(v);
  }

  writeUint32(v: number): void {
    this.hashByte((v >>> 24) & 0x000f);
    this.hashByte((v >>> 16) & 0x000f);
    this.hashByte((v >>> 8) & 0x000f);
    this.hashByte(v & 0x000f);
  }

  writeUint64(v: number): void {
    invariant(v <= Number.MAX_SAFE_INTEGER);
    const msi = (v / maxUint32) | 0;
    const lsi = v % maxUint32;

    // Big endian
    this.writeUint32(msi);
    this.writeUint32(lsi);
  }

  hashVarint(n: number) {
    if (this.lengthOnly) {
      this.bytesHashed += varintEncodingLength(n);
      return;
    }

    const count = encodeVarint(n, varintBuff, 0);
    for (let i = 0; i < count; i++) {
      this.hashByte(varintBuff[i]);
    }
  }

  writeNumber(v: number): void {
    const intAndExp = floatToIntExp(v);
    this.hashVarint(intAndExp[0]);
    this.hashVarint(intAndExp[1]);
  }

  writeBool(v:boolean): void {
    this.writeUint8(v ? 1 : 0);
  }

  writeString(v: string): void {
    // TODO: Avoid this allocation. =-(.
    const buff = Bytes.fromString(v);
    if (this.lengthOnly) {
      this.bytesHashed += 4 + buff.byteLength;
      return;
    }

    this.writeUint32(buff.byteLength);
    for (let i = 0; i < buff.byteLength; i++) {
      this.hashByte(buff[i]);
    }
  }

  writeHash(h: Hash): void {
    const digest = h.digest;
    for (let i = 0; i < digest.byteLength; i++) {
      this.hashByte(digest[i]);
    }
  }

  appendType(t: Type): void { // eslint-disable-line no-unused-vars
    // Type bytes aren't included in the byte stream we chunk over
  }
}
