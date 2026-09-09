import { Box, Text } from "gloomberb/ui";
import { DialogFrame, TextField } from "gloomberb/components";
import { useState } from "react";
import { type PromptContext } from "gloomberb/dialog";
import type { WizardStep } from "gloomberb/types/plugin";
import { colors } from "gloomberb/theme";

export { ChoiceDialog } from "gloomberb/components";

export function InputDialog({ resolve, step }: PromptContext<string> & { step: WizardStep }) {
  const [value, setValue] = useState("");

  return (
    <DialogFrame title={step.label}>
      {step.body?.map((line, index) => (
        <Text key={index} fg={colors.textDim}>{line || " "}</Text>
      ))}
      <Box height={1} />
      <TextField
        focused
        value={value}
        placeholder={step.placeholder || ""}
        onChange={setValue}
        onSubmit={(nextValue) => resolve(nextValue.trim())}
      />
    </DialogFrame>
  );
}
