import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  enabled: true,
  compatible: true,
  connected: true,
  hasPrimary: true,
  update: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () =>
    state.hasPrimary
      ? {
          environmentId: "local-reader",
          label: "Local reader",
          connection: { phase: state.connected ? "connected" : "offline" },
          serverConfig: {
            settings: { amazonBetaEnabled: state.enabled },
            environment: {
              capabilities: { amazonReadConnector: state.compatible },
            },
          },
        }
      : null,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "update-reader" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("./useScopedSettings", () => ({
  useUpdateScopedSettings: () => {
    throw new Error("Must not broadcast to the selected Cloud Desktop scope");
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
import { CodeAmazonSettingsSection } from "./CodeAmazonSettings";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.enabled = state.compatible = state.connected = state.hasPrimary = true;
  state.update.mockReset();
  state.update.mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount() {
  await act(() => {
    renderer = create(<CodeAmazonSettingsSection />);
  });
}
function control() {
  if (!renderer) throw new Error("Not mounted");
  return renderer.root.findByType("button");
}

describe("Code Amazon primary-reader setting", () => {
  it("preserves an existing true opt-in without writing on mount, then deactivates only the primary", async () => {
    await mount();
    expect(control().props["aria-checked"]).toBe(true);
    expect(state.update).not.toHaveBeenCalled();
    await act(async () => {
      await control().props.onClick();
    });
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local-reader",
      input: { patch: { amazonBetaEnabled: false } },
    });
  });
  it("activates only the primary reader using the compatible existing settings key", async () => {
    state.enabled = false;
    await mount();
    await act(async () => {
      await control().props.onClick();
    });
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local-reader",
      input: { patch: { amazonBetaEnabled: true } },
    });
  });
  it.each(["compatible", "connected", "hasPrimary"] as const)(
    "does not send settings when %s is false",
    async (key) => {
      state[key] = false;
      await mount();
      expect(control().props.disabled).toBe(true);
      // Even a forged UI callback must not dispatch to another/older environment.
      await act(async () => {
        await control().props.onClick();
      });
      expect(state.update).not.toHaveBeenCalled();
    },
  );
  it("shows save failure without pretending the stored opt-in changed", async () => {
    state.update.mockResolvedValue({ _tag: "Failure" });
    await mount();
    await act(async () => {
      await control().props.onClick();
    });
    expect(control().props["aria-checked"]).toBe(true);
    expect(renderer?.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Could not save Code Amazon/CRUX beta on the primary reader.",
    );
  });
});
