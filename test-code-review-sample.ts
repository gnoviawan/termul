// This is a test file for code review verification
// It contains intentional issues for the GLM 4.7 Code Reviewer to detect

import { useState } from 'react';

// Issue: Unused variable
const unusedVariable = 'This is never used';

// Issue: Any type usage
function processData(data: any): any {
  // Issue: Missing error handling
  const result = JSON.parse(data);
  return result;
}

// Issue: Missing return type
function calculate(a, b) {
  return a + b;
}

// Issue: Potential security issue - eval usage
function executeCode(code: string) {
  return eval(code);
}

// Issue: Hardcoded secret
const API_KEY = 'hardcoded-secret-key-12345';

// Issue: Console.log in production code
function debugLog(message: string) {
  console.log('Debug:', message);
}

// Issue: Missing error boundary
async function fetchUserData(userId: string) {
  const response = await fetch(`/api/users/${userId}`);
  const data = await response.json();
  return data;
}

// Issue: Inefficient loop
function findUserById(users: any[], id: string) {
  for (let i = 0; i < users.length; i++) {
    if (users[i].id === id) {
      return users[i];
    }
  }
}

// Issue: Missing null check
function getUserEmail(user: any) {
  return user.email.toLowerCase();
}

export {
  processData,
  calculate,
  executeCode,
  API_KEY,
  debugLog,
  fetchUserData,
  findUserById,
  getUserEmail
};
