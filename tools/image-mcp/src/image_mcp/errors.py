"""Stable error codes the bot can branch on.

Every failure a bot can act upon is raised as a CodedError whose message starts with the
code and a colon, so the bot reads one token and decides. The codes are part of the tool
contract; do not rename them without updating docs and bots.
"""

from __future__ import annotations

CODE_IMAGE_DISABLED = "image_disabled"
CODE_INVALID_PROMPT = "invalid_prompt"
CODE_INVALID_MODEL = "invalid_model"
CODE_INVALID_SIZE = "invalid_size"
CODE_INVALID_N = "invalid_n"
CODE_BUDGET_EXCEEDED = "budget_exceeded"
CODE_UPSTREAM_ERROR = "upstream_error"
CODE_DOCUMENT_TOO_LARGE = "document_too_large"
CODE_QUOTA_EXCEEDED = "quota_exceeded"
CODE_TOOL_DISABLED = "tool_disabled"


class CodedError(Exception):
    """Carries a stable code; str() is safe to show the bot."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")