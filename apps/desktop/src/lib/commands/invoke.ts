import { invoke } from "@tauri-apps/api/core";
import type { ZodType } from "zod";

interface CommandContract<TInput, TOutput> {
  command: string;
  input: ZodType<TInput>;
  output: ZodType<TOutput>;
}

export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandValidationError";
  }
}

export async function invokeTyped<TInput, TOutput>(
  contract: CommandContract<TInput, TOutput>,
  input: TInput
): Promise<TOutput> {
  const parsedInput = contract.input.safeParse(input);
  if (!parsedInput.success) {
    throw new CommandValidationError(parsedInput.error.message);
  }

  const raw = await invoke(contract.command, { payload: parsedInput.data });
  const parsedOutput = contract.output.safeParse(raw);
  if (!parsedOutput.success) {
    throw new CommandValidationError(parsedOutput.error.message);
  }

  return parsedOutput.data;
}

