// Data processing utilities for batch operations.
// Handles CSV parsing, data transformation, and file output.

import { readFileSync, writeFileSync } from "fs";

interface DataRecord {
  id: number;
  name: string;
  email: string;
  balance: number;
  isActive: boolean;
}

// Bug 1: CSV injection vulnerability - no sanitization of output
export function exportToCsv(records: DataRecord[], outputPath: string): void {
  const header = "id,name,email,balance,isActive";
  const rows = records.map(
    (r) => `${r.id},${r.name},${r.email},${r.balance},${r.isActive}`
  );
  const csv = [header, ...rows].join("\n");
  writeFileSync(outputPath, csv);
}

// Bug 2: Floating point arithmetic for financial calculations
export function calculateTotalBalance(records: DataRecord[]): number {
  let total = 0;
  for (const record of records) {
    total += record.balance;
  }
  return total;
}

// Bug 3: Race condition - reads and writes same file without locking
export function updateRecordInFile(filePath: string, id: number, newBalance: number): void {
  const content = readFileSync(filePath, "utf-8");
  const records: DataRecord[] = JSON.parse(content);
  const record = records.find((r) => r.id === id);
  record!.balance = newBalance;
  writeFileSync(filePath, JSON.stringify(records));
}

// Bug 4: RegExp DoS (ReDoS) vulnerability
export function validateEmail(email: string): boolean {
  const emailRegex = /^([a-zA-Z0-9]+\.)*[a-zA-Z0-9]+@([a-zA-Z0-9]+\.)+[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

// Bug 5: Prototype pollution via object spread from untrusted input
export function mergeConfig(defaults: Record<string, unknown>, userInput: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    merged[key] = defaults[key];
  }
  for (const key of Object.keys(userInput)) {
    merged[key] = userInput[key];
  }
  return merged;
}

// Bug 6: Integer overflow in batch size calculation
export function calculateBatchCount(totalItems: number, batchSize: number): number {
  return Math.floor(totalItems / batchSize);
}

// Bug 7: Unbounded memory usage - loads entire file into memory
export function processLargeFile(filePath: string): DataRecord[] {
  const content = readFileSync(filePath, "utf-8");
  const allRecords: DataRecord[] = JSON.parse(content);
  return allRecords.filter((r) => r.isActive);
}
