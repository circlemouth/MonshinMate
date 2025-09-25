import pyotp
secret='gAAAAABnZsuxvWx9z8eBjsc_abc'
print(pyotp.TOTP(secret).now())
