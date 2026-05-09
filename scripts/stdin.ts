import * as readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => {
      resolve(answer.trim());
    });
  });
}

export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question} (shown in plain text): `, (answer) => {
      resolve(answer);
    });
  });
}

export function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${question} (y/N): `, (answer) => {
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

export function closeStdin(): void {
  rl.close();
}
