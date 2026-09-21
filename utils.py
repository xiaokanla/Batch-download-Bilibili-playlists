# utils.py
import time
import hashlib
import urllib.parse
from functools import reduce

class WbiSigner:
    @staticmethod
    def get_mixin_key(orig: str):
        mixinKeyEncTab = [
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
            33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
            61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
            36, 20, 34, 44, 52
        ]
        return reduce(lambda s, i: s + orig[i], mixinKeyEncTab, '')[:32]

    @staticmethod
    def enc_wbi(params: dict, img_key: str, sub_key: str):
        mixin_key = WbiSigner.get_mixin_key(img_key + sub_key)
        curr_time = round(time.time())
        params['wts'] = curr_time
        params = dict(sorted(params.items()))
        params = {
            k: ''.join(filter(lambda chr: chr not in "!'()*", str(v)))
            for k, v in params.items()
        }
        query = urllib.parse.urlencode(params)
        wbi_sign = hashlib.md5((query + mixin_key).encode()).hexdigest()
        params['w_rid'] = wbi_sign
        return params

    @staticmethod
    def get_wbi_keys(sess):
        try:
            for _ in range(3):
                resp = sess.get('https://api.bilibili.com/x/web-interface/nav', timeout=10)
                if resp.status_code == 200:
                    json_content = resp.json()
                    img_url = json_content['data']['wbi_img']['img_url']
                    sub_url = json_content['data']['wbi_img']['sub_url']
                    img_key = img_url.rsplit('/', 1)[1].split('.')[0]
                    sub_key = sub_url.rsplit('/', 1)[1].split('.')[0]
                    return img_key, sub_key
                time.sleep(1)
            return None, None
        except: return None, None

class BiliResolver:
    @staticmethod
    def stream_urls(stream):
        """Return official CDN candidates, preferring regular UPOS over mCDN."""
        if not isinstance(stream, dict):
            return []

        candidates = []
        for key in ("baseUrl", "base_url", "url"):
            value = stream.get(key)
            if value:
                candidates.append(str(value))
        for key in ("backupUrl", "backup_url"):
            values = stream.get(key) or []
            if isinstance(values, str):
                values = [values]
            candidates.extend(str(value) for value in values if value)

        unique = []
        seen = set()
        for url in candidates:
            if not url.startswith(("http://", "https://")) or url in seen:
                continue
            seen.add(url)
            unique.append(url)

        # mCDN can be much slower on some networks. These are all URLs from the
        # same playurl response, so changing their order adds no Bilibili API calls.
        return sorted(unique, key=lambda url: ("mcdn" in urllib.parse.urlparse(url).netloc.lower(),))

    @staticmethod
    def get_video_stream(bvid, sess, quality_label="1080"):
        try:
            view_url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
            resp = sess.get(view_url, timeout=15).json()
            if resp['code'] != 0: raise Exception(resp['message'])
            cid = resp['data']['cid']
            title = resp['data']['title']
            duration = resp['data'].get('duration', 0)
            
            # [策略] 
            # 1080 -> qn=116 (优先拿60帧/高码率, B站会自动降级)
            target_qn = 116 
            if quality_label == "4K": target_qn = 120
            elif quality_label == "2K": target_qn = 116
            elif quality_label == "720": target_qn = 64
            elif quality_label == "480": target_qn = 32
            
            play_url = f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn={target_qn}&fnval=16&fnver=0&fourk=1"
            play_resp = sess.get(play_url, timeout=15).json()
            if play_resp['code'] != 0: raise Exception(play_resp['message'])
            data = play_resp['data']
            
            if 'dash' in data:
                # 排序：id降序(画质) -> bandwidth降序(码率)
                video_streams = data['dash'].get('video') or []
                if not video_streams:
                    raise Exception("API未返回可用视频流")
                best_video = sorted(video_streams, key=lambda x: (x['id'], x.get('bandwidth', 0)), reverse=True)[0]
                
                audio_streams = data['dash'].get('audio') or []
                if not audio_streams:
                    raise Exception("API未返回可用音频流")
                best_audio = sorted(audio_streams, key=lambda x: x.get('bandwidth', 0), reverse=True)[0]
                
                video_urls = BiliResolver.stream_urls(best_video)
                audio_urls = BiliResolver.stream_urls(best_audio)
                if not video_urls or not audio_urls:
                    raise Exception("API未返回可用音视频地址")

                return {
                    'type': 'dash',
                    'video_url': video_urls[0],
                    'audio_url': audio_urls[0],
                    'video_urls': video_urls,
                    'audio_urls': audio_urls,
                    'title': title,
                    'quality_id': best_video['id']
                }, title, duration
            elif 'durl' in data:
                durl_urls = BiliResolver.stream_urls(data['durl'][0])
                if not durl_urls:
                    raise Exception("API未返回可用下载地址")
                return {'type': 'durl', 'url': durl_urls[0], 'urls': durl_urls, 'title': title}, title, duration
            else: return None, None, 0
        except Exception as e:
            print(f"Resolver: {e}")
            return None, None, 0
