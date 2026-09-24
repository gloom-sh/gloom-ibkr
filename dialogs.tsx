import { Box, Text } from "gloomberb/ui";
import { Button, DialogFrame, TextField } from "gloomberb/components";
import { useState } from "react";
import { type PromptContext } from "gloomberb/dialog";
import type { WizardStep } from "gloomberb/types/plugin";
import { colors } from "gloomberb/theme";

export { ChoiceDialog } from "gloomberb/components";

export function InputDialog({
  resolve,
  dismiss,
  step,
  submitLabel = "Save",
}: PromptContext<string> & { step: WizardStep; submitLabel?: string }) {
  const [value, setValue] = useState("");
  const submit = (nextValue: string) => resolve(nextValue.trim());

  return (
    <DialogFrame title={step.label}>
      {step.body?.map((line, index) => (
        <Text key={index} fg={colors.textDim}>{line || " "}</Text>
      ))}
      {step.body && step.body.length > 0 && <Box height={1} />}
      <TextField
        focused
        value={value}
        placeholder={step.placeholder || ""}
        onChange={setValue}
        onSubmit={submit}
      />
      <Box height={1} />
      <Box flexDirection="row" gap={1}>
        <Button label={submitLabel} variant="primary" onPress={() => submit(value)} />
        <Button label="Cancel" variant="secondary" onPress={dismiss} />
      </Box>
    </DialogFrame>
  );
}
