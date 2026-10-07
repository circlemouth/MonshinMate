"""HTTP contract for protected admin authentication and enrollment."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel, Field

from . import admin_security as security
from .api_policy import protected_route_class


def _require_admin(authorization: str | None = Header(default=None)) -> dict:
    return security.decode_access(authorization)


# Included routers retain their own route class; the app-level class alone is
# insufficient to protect future endpoints added to this module.
router = APIRouter(route_class=protected_route_class(_require_admin))


class LoginRequest(BaseModel):
    password: str = Field(max_length=256)


class LoginTotpRequest(BaseModel):
    challenge_token: str = Field(min_length=1, max_length=256)
    totp_code: str = Field(max_length=32)


class OfflineRequest(BaseModel):
    credential: str = Field(min_length=1, max_length=256)
    new_password: str = Field(max_length=256)


class ReauthRequest(LoginRequest):
    totp_code: str | None = Field(default=None, max_length=32)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


class EnrollmentVerifyRequest(BaseModel):
    enrollment_id: str = Field(min_length=1, max_length=256)
    totp_code: str = Field(max_length=32)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


@router.get("/admin/auth/status")
def auth_status(response: Response, authorization: str | None = Header(default=None)) -> dict:
    _no_store(response)
    return security.auth_status(authorization)


@router.post("/admin/login")
def login(payload: LoginRequest, response: Response) -> dict:
    _no_store(response)
    return security.login(payload.password)


@router.post("/admin/login/totp")
def login_totp(payload: LoginTotpRequest, response: Response) -> dict:
    _no_store(response)
    return security.login_totp(payload.challenge_token, payload.totp_code)


@router.post("/admin/bootstrap")
def bootstrap(payload: OfflineRequest, response: Response) -> dict:
    _no_store(response)
    return security.consume_offline_credential("bootstrap", payload.credential, payload.new_password)


@router.post("/admin/recovery")
def recovery(payload: OfflineRequest, response: Response) -> dict:
    _no_store(response)
    return security.consume_offline_credential("recovery", payload.credential, payload.new_password)


@router.post("/admin/reauth")
def reauth(payload: ReauthRequest, response: Response,
           authorization: str | None = Header(default=None)) -> dict:
    _no_store(response)
    return security.reauthenticate(authorization, payload.password, payload.totp_code)


@router.post("/admin/password/change")
def change_password(payload: PasswordChangeRequest,
                    authorization: str | None = Header(default=None),
                    x_admin_reauth: str | None = Header(default=None)) -> dict:
    return security.change_password(authorization, x_admin_reauth, payload.current_password, payload.new_password)


@router.post("/admin/totp/setup")
@router.post("/admin/totp/regenerate")
def setup_totp(response: Response, authorization: str | None = Header(default=None),
               x_admin_reauth: str | None = Header(default=None)) -> dict:
    _no_store(response)
    return security.setup_totp(authorization, x_admin_reauth)


@router.post("/admin/totp/verify")
def verify_totp(payload: EnrollmentVerifyRequest, response: Response,
                authorization: str | None = Header(default=None),
                x_admin_reauth: str | None = Header(default=None)) -> dict:
    _no_store(response)
    return security.verify_enrollment(authorization, x_admin_reauth, payload.enrollment_id, payload.totp_code)


@router.post("/admin/totp/disable")
def disable_totp(authorization: str | None = Header(default=None),
                 x_admin_reauth: str | None = Header(default=None)) -> dict:
    return security.disable_totp(authorization, x_admin_reauth)


@router.get("/admin/totp/mode")
def totp_mode(authorization: str | None = Header(default=None)) -> dict:
    security.decode_access(authorization)
    return {"mode": "login_and_reset" if security.account().get("mfa") else "off"}


@router.get("/admin/totp/setup")
@router.put("/admin/totp/mode")
@router.post("/admin/password")
@router.post("/admin/password/reset/request")
@router.post("/admin/password/reset/confirm")
@router.post("/admin/password/reset/emergency")
def retired_authentication_flow() -> None:
    # Intentionally no request schema: old clients always receive an explicit 410.
    raise HTTPException(410, "Legacy authentication flow retired; use offline bootstrap/recovery or protected enrollment")
