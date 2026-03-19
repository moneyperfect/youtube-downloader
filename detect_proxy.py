
import socket

def check_port(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        result = s.connect_ex(('127.0.0.1', port))
        return result == 0

def detect_proxy():
    common_ports = [7890, 7891, 1080, 1081, 10808, 10809, 8080, 8888]
    for port in common_ports:
        if check_port(port):
            print(f"Found open port: {port}")
            return f"http://127.0.0.1:{port}"
    return None

if __name__ == "__main__":
    proxy = detect_proxy()
    if proxy:
        print(f"PROXY_DETECTED:{proxy}")
    else:
        print("NO_PROXY_FOUND")
