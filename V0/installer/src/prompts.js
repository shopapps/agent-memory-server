import readline from "node:readline/promises";

export function createPrompter(input = process.stdin, output = process.stdout) {
  return {
    async confirm(message, defaultYes = true) {
      const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
      const answer = (await askLine(input, output, message + suffix)).trim().toLowerCase();
      if (!answer) {
        return defaultYes;
      }
      return answer === "y" || answer === "yes";
    },

    async select(message, choices, defaultIndex = 0) {
      output.write(`${message}\n`);
      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}. ${choice.label}\n`);
      });
      const answer = await askLine(input, output, `Choose [${defaultIndex + 1}]: `);
      const index = answer.trim() ? Number(answer.trim()) - 1 : defaultIndex;
      if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
        output.write("Please choose one of the listed numbers.\n");
        return this.select(message, choices, defaultIndex);
      }
      return choices[index].value;
    },

    async secret(message) {
      if (!input.isTTY || typeof input.setRawMode !== "function") {
        return "";
      }
      output.write(`${message}: `);
      input.setRawMode(true);
      input.resume();
      input.setEncoding("utf8");

      return new Promise((resolve, reject) => {
        let value = "";
        let settled = false;

        const finish = (error = null) => {
          if (settled) {
            return;
          }
          settled = true;
          input.off("data", onData);
          input.off("end", onEnd);
          input.off("error", onError);
          if (input.isRaw) {
            input.setRawMode(false);
          }
          input.pause();
          output.write("\n");
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        };

        const onEnd = () => finish(new Error("Input ended before the secret was complete."));
        const onError = (error) => finish(error);

        const onData = (chunk) => {
          for (const character of chunk) {
            if (character === "\u0003") {
              finish(new Error("Cancelled"));
              return;
            }
            if (character === "\r" || character === "\n") {
              finish();
              return;
            }
            if (character === "\u007f") {
              if (value.length > 0) {
                value = value.slice(0, -1);
                output.write("\b \b");
              }
              continue;
            }
            if (character >= " ") {
              value += character;
              output.write("*");
            }
          }
        };

        input.on("data", onData);
        input.once("end", onEnd);
        input.once("error", onError);
      });
    },
  };
}

async function askLine(input, output, message) {
  const prompt = readline.createInterface({ input, output });
  try {
    return await prompt.question(message);
  } finally {
    prompt.close();
  }
}
