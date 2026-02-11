// Sample utility module for testing BugHunter detection.
// Contains intentional bugs for validation purposes.

interface UserData {
  name: string;
  email: string;
  age: number;
  role: "admin" | "user" | "guest";
}

// Bug 1: SQL injection vulnerability - string interpolation in query
export function findUserByEmail(db: any, email: string): UserData | null {
  const query = `SELECT * FROM users WHERE email = '${email}'`;
  const result = db.query(query);
  return result.length > 0 ? result[0] : null;
}

// Bug 2: Off-by-one error in pagination
export function paginateResults<T>(items: T[], page: number, pageSize: number): T[] {
  const startIndex = page * pageSize;
  const endIndex = startIndex + pageSize + 1;
  return items.slice(startIndex, endIndex);
}

// Bug 3: Missing null check leads to potential crash
export function getUserDisplayName(user: UserData | null): string {
  return user.name.toUpperCase();
}

// Bug 4: Async function that doesn't await properly
export async function fetchAndProcessUsers(apiUrl: string): Promise<string[]> {
  const response = fetch(apiUrl);
  const data = (response as any).json();
  return data.map((user: UserData) => user.name);
}

// Bug 5: Comparison with wrong type / always true condition
export function isValidAge(age: number): boolean {
  if (age >= 0 || age <= 150) {
    return true;
  }
  return false;
}

// Bug 6: Password stored in plain text in error message
export function authenticateUser(username: string, password: string): boolean {
  const validPassword = "super_secret_123";
  if (password !== validPassword) {
    console.log(`Authentication failed for ${username} with password ${password}`);
    return false;
  }
  return true;
}
