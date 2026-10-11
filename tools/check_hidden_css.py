#!/usr/bin/env python3
"""Guard against author CSS overriding the `hidden` attribute.

The browser hides `hidden` elements with a user-agent rule of
`display: none`, but ANY author rule that sets `display` on the same element
wins, silently leaving the element on screen. That shipped once as a popup
that could not be dismissed, so it is now checked automatically.

For every element in the HTML carrying `hidden`, this finds CSS rules that
set `display` for its id or classes and insists on a matching `[hidden]`
override.
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CSS = os.path.join(ROOT, "www", "styles.css")
# app.js builds rows from template strings, so its markup is checked too.
MARKUP_FILES = [
    os.path.join(ROOT, "www", "index.html"),
    os.path.join(ROOT, "www", "app.js"),
]


def strip_comments(css):
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def find_hidden_elements(html):
    """Return [(tag, id, [classes])] for every element with a hidden attribute."""
    out = []
    for tag in re.finditer(r"<(\w+)([^>]*\bhidden\b[^>]*)>", html):
        attrs = tag.group(2)
        el_id = re.search(r'id="([^"]+)"', attrs)
        classes = re.search(r'class="([^"]+)"', attrs)
        out.append((
            tag.group(1),
            el_id.group(1) if el_id else None,
            classes.group(1).split() if classes else [],
        ))
    return out


def rules_with_display(css):
    """Return [(selector_text, declarations)] for rules that set `display`."""
    found = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        selector = " ".join(m.group(1).split())
        body = m.group(2)
        if re.search(r"(^|[;\s])display\s*:", body):
            found.append((selector, body.strip()))
    return found


def selector_targets(selector, el_id, classes):
    """Does this selector target the element by a bare id/class (no [hidden])?"""
    for part in selector.split(","):
        part = part.strip()
        if "[hidden]" in part or ":not([hidden])" in part:
            continue
        # only care about the final compound selector, which is what matches
        last = re.split(r"[\s>+~]+", part)[-1]
        if el_id and last == f"#{el_id}":
            return part
        for cls in classes:
            if last == f".{cls}":
                return part
    return None


def find_duplicate_ids(html):
    """Return {id: count} for every id used more than once.

    Duplicate ids are legal HTML, so nothing complains - but querySelector
    returns only the first match, leaving the others silently unwired. That
    shipped once as a version number stuck on "dev" in Settings while the
    main screen showed the real one, which made an update look as though it
    had not landed.
    """
    counts = {}
    for m in re.finditer(r'\sid="([^"]+)"', html):
        counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    return {k: v for k, v in counts.items() if v > 1}


def main():
    css = strip_comments(open(CSS, encoding="utf-8").read())

    html = open(os.path.join(ROOT, "www", "index.html"), encoding="utf-8").read()
    dupes = find_duplicate_ids(html)

    hidden_elements = []
    for path in MARKUP_FILES:
        markup = open(path, encoding="utf-8").read()
        for el in find_hidden_elements(markup):
            if el not in hidden_elements:
                hidden_elements.append(el)

    display_rules = rules_with_display(css)

    print(f"Elements using the hidden attribute: {len(hidden_elements)}")
    for tag, el_id, classes in hidden_elements:
        label = f"<{tag}" + (f' id="{el_id}"' if el_id else "")
        label += (f' class="{" ".join(classes)}"' if classes else "") + ">"
        print(f"  {label}")

    problems = []
    for tag, el_id, classes in hidden_elements:
        for selector, body in display_rules:
            hit = selector_targets(selector, el_id, classes)
            if not hit:
                continue
            # A bare rule sets display; demand a [hidden] guard for the same class/id
            key = f"#{el_id}" if (el_id and hit == f"#{el_id}") else hit
            guard = any(
                "[hidden]" in s and key.lstrip(".#") in s
                for s, _ in display_rules
            )
            if not guard:
                problems.append(
                    f"{selector} {{ {body} }} sets display on a hidden element "
                    f"({'#' + el_id if el_id else '.' + ' .'.join(classes)}) "
                    f"with no [hidden] override"
                )

    print()
    if problems:
        print("FAILED - the hidden attribute will not work:")
        for p in sorted(set(problems)):
            print(f"  - {p}")
        print("\nFix: add a rule such as `.thing[hidden] { display: none; }`")
        return 1

    if dupes:
        print("FAILED - the same id is used more than once:")
        for name, count in sorted(dupes.items()):
            print(f'  - id="{name}" appears {count} times')
        print("\nquerySelector only ever returns the first, so the rest are")
        print("silently unwired. Use a class for anything that appears more")
        print("than once, as .js-build-id does.")
        return 1

    # Confirm the specific guard we rely on is present and correctly ordered.
    sheet_guard = re.search(r"\.sheet\[hidden\]\s*\{[^}]*display\s*:\s*none", css)
    if not sheet_guard:
        print("FAILED - .sheet[hidden] { display: none } is missing")
        return 1

    print("ok   every hidden element can actually hide")
    print("ok   .sheet[hidden] override present")
    print("ok   every id is used only once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
