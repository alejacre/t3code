import { useState } from "react";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";

/** This is a reader setting, not a project setting or a multi-environment broadcast. */
export function CodeAmazonSettingsSection() {
  const primary = usePrimaryEnvironment();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const compatible = primary?.serverConfig?.environment.capabilities.amazonReadConnector === true;
  const connected = primary?.connection.phase === "connected";
  const enabled = primary?.serverConfig?.settings.amazonBetaEnabled === true;

  return (
    <SettingsSection title="Code Amazon/CRUX beta">
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">Read code.amazon.com reviews in T3</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Primary reader: {primary?.label ?? "not connected"}. This switch applies only to that
            reader, regardless of the selected settings scope. Projects and threads may run on Cloud
            Desktop; credentials stay on the reader. Reviews are read-only.
          </p>
          {!compatible && (
            <p className="text-xs text-muted-foreground">
              Connect a compatible local Code Amazon beta reader to change this setting.
            </p>
          )}
          {compatible && !connected && (
            <p className="text-xs text-muted-foreground">
              Reconnect the primary reader to change this setting.
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <Switch
          aria-label="Code Amazon/CRUX beta"
          checked={enabled}
          disabled={!compatible || !connected || saving}
          onCheckedChange={async (checked) => {
            if (!primary || !compatible || !connected || saving) return;
            setSaving(true);
            setError(null);
            try {
              const result = await updateSettings({
                environmentId: primary.environmentId,
                input: { patch: { amazonBetaEnabled: checked } },
              });
              if (result._tag !== "Success")
                setError("Could not save Code Amazon/CRUX beta on the primary reader.");
            } catch {
              setError("Could not save Code Amazon/CRUX beta on the primary reader.");
            } finally {
              setSaving(false);
            }
          }}
        />
      </div>
    </SettingsSection>
  );
}
