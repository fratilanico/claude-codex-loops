// SKILL FRONTMATTER GATE (ships with the pack).
//
// Every SKILL.md in this pack must have YAML frontmatter with EXACTLY two keys —
// `name` and `description` — matching the council skill's shape. The
// description must be a FOLDED block scalar (`description: >`) and, once folded
// to a single line, must end with the trigger sentence `Trigger: /<name>.`.
//
// We parse the frontmatter without a YAML dependency (the pack ships zero
// runtime deps): the frontmatter here is a strict shape (top-level `name:` and a
// folded `description: >` block), which we validate structurally.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PACK_DIR = join(__dirname, "..");
const SKILLS_DIR = join(PACK_DIR, "skills");

const SKILLS = ["pingpong", "pingpong-pr", "pingpong-install", "ccl-loop", "research-loop"];

type Frontmatter = { keys: string[]; name: string; descriptionFolded: string; descriptionIsFolded: boolean };

// Extract and structurally parse the `--- … ---` frontmatter block.
function parseFrontmatter(src: string): Frontmatter {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter block");
  const body = m[1];
  const lines = body.split("\n");

  const keys: string[] = [];
  let name = "";
  let descriptionIsFolded = false;
  const descLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A top-level key is a non-indented `key:` at column 0.
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1];
      keys.push(key);
      const inline = keyMatch[2].trim();
      if (key === "name") {
        name = inline;
      } else if (key === "description") {
        descriptionIsFolded = inline === ">";
        // Gather the indented continuation lines that follow.
        for (let j = i + 1; j < lines.length; j++) {
          const cont = lines[j];
          if (/^\s+\S/.test(cont) || cont.trim() === "") {
            descLines.push(cont.trim());
          } else {
            break;
          }
        }
      }
    }
  }

  const descriptionFolded = descLines.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return { keys, name, descriptionFolded, descriptionIsFolded };
}

describe("skills frontmatter: exactly name + description, folded, ends with Trigger", () => {
  for (const skill of SKILLS) {
    it(`${skill}/SKILL.md exists`, () => {
      expect(existsSync(join(SKILLS_DIR, skill, "SKILL.md"))).toBe(true);
    });

    it(`${skill}/SKILL.md has EXACTLY the keys name + description`, () => {
      const src = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(src);
      expect(fm.keys).toEqual(["name", "description"]);
    });

    it(`${skill}/SKILL.md name matches its directory`, () => {
      const src = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(src);
      expect(fm.name).toBe(skill);
    });

    it(`${skill}/SKILL.md description is a folded block scalar`, () => {
      const src = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(src);
      expect(fm.descriptionIsFolded).toBe(true);
    });

    it(`${skill}/SKILL.md folded description ends with "Trigger: /${skill}."`, () => {
      const src = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(src);
      expect(fm.descriptionFolded.endsWith(`Trigger: /${skill}.`)).toBe(true);
    });
  }
});
