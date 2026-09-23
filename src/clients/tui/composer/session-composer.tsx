/** @jsxImportSource @opentui/react */

import { RenderableEvents, type TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  useSessionClientStore,
  useSessionState,
} from "../../use-session-state.ts";
import { presentComposer } from "./composer-presentation.ts";
import { accentRailBorderCharacters, colors } from "../theme.ts";

export function SessionComposer({
  sessionID,
  focused,
  onFocus,
}: {
  sessionID: string | undefined;
  focused: boolean;
  onFocus(): void;
}) {
  const store = useSessionClientStore();
  const session = useSessionState(sessionID);
  const input = useRef<TextareaRenderable>(null);
  const [draft, setDraft] = useState("");
  const presentation = useMemo(
    () => presentComposer(sessionID, session),
    [sessionID, session],
  );

  useEffect(() => {
    setDraft("");
    input.current?.clear();
  }, [sessionID]);

  useEffect(() => {
    const editor = input.current;
    if (!editor) return;
    let active = true;

    const showCursor = () => {
      if (
        !active ||
        editor.isDestroyed ||
        !presentation.enabled ||
        input.current !== editor
      ) {
        return;
      }
      const cursor = editor.editorView.getVisualCursor();
      editor.ctx.setCursorPosition(
        editor.screenX + cursor.visualCol + 1,
        editor.screenY + cursor.visualRow + 1,
        true,
      );
      editor.ctx.setCursorStyle({
        ...editor.cursorStyle,
        color: editor.cursorColor,
      });
    };

    // EditBufferRenderable hides the terminal cursor after emitting BLURRED.
    // Restore it after that blur finishes so mouse focus can move elsewhere
    // without making the Composer's insertion point disappear.
    const restoreAfterBlur = () => queueMicrotask(showCursor);
    editor.on(RenderableEvents.BLURRED, restoreAfterBlur);

    if (!presentation.enabled) {
      editor.ctx.setCursorPosition(0, 0, false);
    } else {
      showCursor();
    }

    return () => {
      active = false;
      editor.off(RenderableEvents.BLURRED, restoreAfterBlur);
      if (!editor.isDestroyed && !editor.focused) {
        editor.ctx.setCursorPosition(0, 0, false);
      }
    };
  }, [draft, focused, presentation.enabled, sessionID]);

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      if (!sessionID || !text) return;
      setDraft("");
      input.current?.clear();
      try {
        await store.sendText(sessionID, text);
      } catch {
        setDraft(text);
        input.current?.setText(text);
        input.current?.gotoBufferEnd();
      }
    },
    [store, sessionID],
  );

  const resume = useCallback(async () => {
    if (!sessionID) return;
    try {
      await store.resume(sessionID);
    } catch {
      // The shared Session state exposes the error to Composer and transcript.
    }
  }, [store, sessionID]);

  useKeyboard((key) => {
    if (!key.ctrl || !sessionID) return;
    if (key.name === "u") {
      key.preventDefault();
      void resume();
    }
  });

  return (
    <box
      onMouseDown={onFocus}
      border={["left"]}
      borderStyle="heavy"
      customBorderChars={accentRailBorderCharacters}
      borderColor={colors.composer}
      style={{
        width: "100%",
        minHeight: 3,
        flexShrink: 0,
        paddingLeft: 1,
        backgroundColor: colors.background,
      }}
    >
      <textarea
        ref={input}
        initialValue={draft}
        placeholder={presentation.placeholder}
        focused={focused && presentation.enabled}
        onContentChange={() => {
          setDraft(input.current?.plainText ?? "");
        }}
        onSubmit={() => {
          void submit(input.current?.plainText ?? draft);
        }}
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "kpenter", action: "submit" },
          // Terminals encode Ctrl+J as ASCII line feed.
          { name: "linefeed", action: "newline" },
        ]}
        style={{
          minHeight: 2,
          maxHeight: 6,
          width: "100%",
          textColor: colors.text,
          wrapMode: "word",
        }}
      />
      <box style={{ height: 1, flexShrink: 0 }}>
        <ComposerStatus {...presentation.status} />
      </box>
    </box>
  );
}

const activityFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function ComposerStatus({
  label,
  animated,
}: {
  label: string;
  animated: boolean;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!animated) {
      setFrame(0);
      return;
    }
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % activityFrames.length);
    }, 80);
    return () => clearInterval(timer);
  }, [animated]);

  return (
    <text fg={colors.muted}>
      <span style={{ fg: colors.composer }}>
        {animated ? activityFrames[frame] : activityFrames[0]}
      </span>{" "}
      {label}
    </text>
  );
}
