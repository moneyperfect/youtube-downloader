
import requests

def test_download():
    url = "http://localhost:8000/api/download"
    data = {"url": "https://www.youtube.com/watch?v=x9cU4X-d23k"}
    try:
        response = requests.post(url, json=data)
        print(response.json())
    except Exception as e:
        print(e)
if __name__ == "__main__":
    test_download()
