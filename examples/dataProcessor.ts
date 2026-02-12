// Data processing utilities for batch operations.
// Handles CSV parsing, data transformation, and file output.

import { readFileSync, writeFileSync, openSync, closeSync, fstatSync } from "fs";
import { createInterface } from "readline";

interface DataRecord {
  id: number;
  name: string;
  email: string;
  balance: number;
  isActive: boolean;
}

// Bug 1: CSV injection vulnerability - no sanitization of output
export function exportToCsv(records: DataRecord[], outputPath: string): void {
  const sanitizeCsvField = (value: string | number | boolean): string => {
    const strValue = String(value);
    if (/^[=+\-@]/.test(strValue)) {
      return `'${strValue.replace(/'/g, "''")}'`;
    }
    return strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')
      ? `"${strValue.replace(/"/g, '""')}"`
      : strValue;
  };
  const header = "id,name,email,balance,isActive";
  const rows = records.map(
    (r) => `${r.id},${sanitizeCsvField(r.name)},${sanitizeCsvField(r.email)},${r.balance},${r.isActive}`
  );
  const csv = [header, ...rows].join("\n");
  writeFileSync(outputPath, csv);
}

// Bug 2: Floating point arithmetic for financial calculations
export function calculateTotalBalance(records: DataRecord[]): number {
  let totalCents = 0;
  for (const record of records) {
    totalCents += Math.round(record.balance * 100);
  }
  return totalCents / 100;
}

// Bug 3: Race condition - reads and writes same file without locking
export function updateRecordInFile(filePath: string, id: number, newBalance: number): void {
  const fd = openSync(filePath, "r+");
  try {
    const stats = fstatSync(fd);
    const content = readFileSync(fd, "utf-8");
    let records: DataRecord[];
    try {
      records = JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid JSON in file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record = records.find((r) => r.id === id);
    if (!record) {
      throw new Error(`Record with id ${id} not found`);
    }
    record.balance = newBalance;
    writeFileSync(fd, JSON.stringify(records));
  } finally {
    closeSync(fd);
  }
}

// Bug 4: RegExp DoS (ReDoS) vulnerability
export function validateEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

// Bug 5: Prototype pollution via object spread from untrusted input
export function mergeConfig(defaults: Record<string, unknown>, userInput: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
  for (const key of Object.keys(defaults)) {
    merged[key] = defaults[key];
  }
  for (const key of Object.keys(userInput)) {
    if (!dangerousKeys.includes(key)) {
      merged[key] = userInput[key];
    }
  }
  return merged;
}

// Bug 6: Integer overflow in batch size calculation
export function calculateBatchCount(totalItems: number, batchSize: number): number {
  return Math.ceil(totalItems / batchSize);
}

// Bug 7: Unbounded memory usage - loads entire file into memory
export async function processLargeFile(filePath: string): Promise<DataRecord[]> {
  const fs = await import("fs");
  const readline = await import("readline");
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const activeRecords: DataRecord[] = [];
  let isFirstLine = true;
  let buffer = '';

  for await (const line of rl) {
    buffer += line;
    try {
      const records: DataRecord[] = JSON.parse(buffer);
      activeRecords.push(...records.filter((r) => r.isActive));
      buffer = '';
    } catch (error) {
      if (isFirstLine) {
        throw new Error(`Invalid JSON in file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    isFirstLine = false;
  }

  return activeRecords;
}
