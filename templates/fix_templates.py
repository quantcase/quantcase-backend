import os
import re

for filename in os.listdir('.'):
    if not filename.endswith('-compressed-template.hbs'):
        continue

    with open(filename, 'r') as f:
        content = f.read()

    # Fix 1: guidance-credibility inline clamp
    content = re.sub(
        r"\.intuition-heading \{ margin: 38px 0 10px; font-family: 'Source Serif 4', Georgia, serif; font-size: clamp\(25px, 4vw, 38px\); font-weight: 500; line-height: 1\.15; \}",
        r".intuition-heading { margin: 38px 0 10px; font: 600 27px/1.2 'Source Serif 4', Georgia, serif; }",
        content
    )

    # Fix 2: disclosure-honesty multiline clamp
    content = re.sub(
        r"\.intuition-heading \{\s*margin: 38px 0 10px;\s*font-family: 'Source Serif 4', Georgia, serif;\s*font-size: clamp\(25px, 4vw, 38px\);\s*font-weight: 500;\s*line-height: 1\.15\s*\}",
        r".intuition-heading {\n      margin: 38px 0 10px;\n      font: 600 27px/1.2 'Source Serif 4', Georgia, serif\n    }",
        content
    )

    # Fix 3: mobile font-sizes for ALL templates
    # This matches `.intuition-heading { margin-top: Xpx; font-size: 24px; }` inline
    content = re.sub(
        r"(\.intuition-heading \{\s*margin-top: \d+px;)\s*font-size: 24px;\s*\}",
        r"\1 font-size: 22px; }",
        content
    )

    # This matches multiline `.intuition-heading {\n margin-top: Xpx;\n font-size: 24px\n }`
    content = re.sub(
        r"(\.intuition-heading \{\s*margin-top: \d+px;\s*)font-size: 24px(\s*\})",
        r"\1font-size: 22px\2",
        content
    )

    # Fix 4: For templates where mobile font-size was not defined at all (e.g. disclosure-honesty and guidance-credibility)
    # Inline (guidance-credibility)
    content = re.sub(
        r"(\.intuition-heading \{ margin-top: \d+px;) \}",
        r"\1 font-size: 22px; }",
        content
    )
    
    # Multiline (disclosure-honesty)
    # Wait, regex is a bit tricky, let's use carefully.
    content = re.sub(
        r"(\.intuition-heading \{\s*margin-top: 28px)\s*\}",
        r"\1;\n        font-size: 22px\n      }",
        content
    )

    with open(filename, 'w') as f:
        f.write(content)

print("Done")
