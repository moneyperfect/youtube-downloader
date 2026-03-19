
import yt_dlp
import os
import time

def test_download():
    urls = [
        # "https://www.youtube.com/watch?v=80sNX81Kags",
        "https://www.youtube.com/shorts/eWgC8GXWV9A"
    ]
    download_dir = "downloads_test"
    if not os.path.exists(download_dir):
        os.makedirs(download_dir)
    
    # Options strictly following the current downloader.py logic
    # BUT with verbose output to see what's happening
    opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': f'{download_dir}/%(title)s.%(ext)s',
        'quiet': False,
        'no_warnings': False,
        'nopart': True,
        'verbose': True,
        'http_chunk_size': 10485760, # 10MB
        'retries': 10,
        'fragment_retries': 10,
        'nocheckcertificate': True,
        'source_address': '0.0.0.0',
    }

    for url in urls:
        print(f"\n\nTesting download for: {url}")
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                try:
                    ydl.download([url])
                    print("Download command finished.")
                except yt_dlp.utils.DownloadError as e:
                    print(f"Caught DownloadError: {e}")
                    if "ffmpeg is not installed" in str(e) or "merging" in str(e):
                        print("FFmpeg missing detected. Retrying with fallback...")
                        opts_fallback = opts.copy()
                        opts_fallback['format'] = 'best[ext=mp4]/best'
                        with yt_dlp.YoutubeDL(opts_fallback) as ydl_fallback:
                            ydl_fallback.download([url])
                    else:
                        raise e
                        
        except Exception as e:
            print(f"CRITICAL EXCEPTION: {str(e)}")

if __name__ == "__main__":
    test_download()
