import os

REPLACEMENTS = {
    # Anthropic
    "claude-sonnet-latest": "claude-sonnet-5",
    "claude-haiku-latest": "claude-haiku-4.5",
    "claude-opus-latest": "claude-opus-5",
    "claude-fable-latest": "claude-fable-5",

    # xAI
    "grok-latest": "grok-4.5",

    # Gemini
    "gemini-3.5-flash-lite": "gemini-flash-lite-latest",

    # DeepSeek
    "deepseek-r1-latest": "deepseek-reasoner",
    "deepseek-flash-latest": "deepseek-v4-flash",
    "deepseek-pro-latest": "deepseek-v4-pro",

    # Mistral
    "mistral-small-2603": "mistral-small-latest",
    "mistral-medium-3.5": "mistral-medium-latest",

    # OpenAI
    "gpt-sol-latest": "gpt-5.6-sol",
    "gpt-terra-latest": "gpt-5.6-terra",
    "gpt-luna-latest": "gpt-5.6-luna",
    "gpt-mini-latest": "gpt-5.4-mini",
    "gpt-nano-latest": "gpt-5.4-nano",
    "gpt-4o-latest": "gpt-4o",
}

def replace_in_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    new_content = content
    for old_slug, new_slug in REPLACEMENTS.items():
        new_content = new_content.replace(f'"{old_slug}"', f'"{new_slug}"')
        new_content = new_content.replace(f"'{old_slug}'", f"'{new_slug}'")

    if content != new_content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Updated {filepath}")

for root, dirs, files in os.walk("."):
    if "node_modules" in root or ".next" in root or ".git" in root or "dist" in root:
        continue
    for file in files:
        if file.endswith(".ts") or file.endswith(".tsx"):
            replace_in_file(os.path.join(root, file))
