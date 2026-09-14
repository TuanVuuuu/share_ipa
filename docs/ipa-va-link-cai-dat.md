# Logic đọc file IPA và tạo link cài đặt

Tài liệu mô tả luồng từ lúc server nhận file `.ipa` đến lúc người dùng (tester) mở được màn hình cài đặt trên iPhone/iPad.

Luồng xử lý chung nằm trong `processUploadedIpa()` (`server.js`). Mọi kênh upload (một lần, chunk, LAN, R2) đều hội tụ vào hàm này sau khi file đã nằm trên đĩa.

## Tổng quan

iOS **không cài IPA bằng URL file trực tiếp**. Safari chỉ nhận lệnh OTA (over-the-air) qua scheme `itms-services://`, trỏ tới một file **manifest plist**. Plist đó mới chứa URL thật của file IPA.

Vì vậy hệ thống tạo **hai loại URL**:

| Loại | Dạng | Người dùng làm gì |
|------|------|-------------------|
| **shareUrl** | `https://…/install?plist=<tên-file>.plist` | Mở trang web, quét QR, copy/share |
| **downloadUrl** | `itms-services://?action=download-manifest&url=<manifestUrl>` | iOS đọc manifest rồi tải IPA |

Android khác: APK tải thẳng, không cần plist. `downloadUrl` = URL file, `shareUrl` dùng `?id=` thay vì `?plist=`.

```
Upload IPA  →  lưu file  →  parse metadata  →  ghi manifest .plist
                                                      ↓
                              shareUrl (/install?plist=…)     downloadUrl (itms-services://…)
                                                      ↓
                              Catalog (GitHub) + QR + trang /install
                                                      ↓
                              Tester mở Safari → iOS tải IPA theo URL trong plist
```

## 1. Nhận và đặt tên file

File được lưu vào thư mục uploads (`UPLOADS_MAIN_DIR`). Tên chuẩn:

```
app_<timestamp>_<tên-gốc>
```

Ví dụ: `app_1710000000000_MyApp.ipa`.

Các kênh upload:

| Endpoint | Cách nhận file |
|----------|----------------|
| `POST /api/upload-secure` | Multipart (`ipaFile`), multer ghi thẳng ra đĩa |
| `POST /api/upload-lan` | Body thô, header `X-File-Name`, stream ra đĩa |
| `POST /api/upload-finalize` | Ghép các chunk trong `uploads/chunks/` |
| `POST /api/r2-finalize` | File đã lên Cloudflare R2; server tải về tạm để parse |

Giới hạn kích thước upload một lần: **500 MB**.

Sau khi có `finalFilename` + `finalPath` trên đĩa, server gọi `processUploadedIpa()`.

## 2. Đọc metadata từ IPA

Thư viện: [`app-info-parser`](https://www.npmjs.com/package/app-info-parser).

```js
const parser = new AppInfoParser(finalPath);
const result = await parser.parse();
const appInfo = mapParsedAppInfo(result, 'ios');
```

IPA là file ZIP. Parser mở archive, đọc `Payload/*.app/Info.plist` và (nếu có) provisioning profile nhúng.

### Trường lấy từ Info.plist

| Trường hệ thống | Nguồn trong IPA | Fallback |
|-----------------|-----------------|----------|
| `bundleId` | `CFBundleIdentifier` | `com.unknown.app` |
| `version` | `CFBundleShortVersionString` | `1.0.0` |
| `buildNumber` | `CFBundleVersion` | `1` |
| `appName` | `CFBundleDisplayName` rồi `CFBundleName` | `Ứng dụng iOS` |
| `minimumOsVersion` | `MinimumOSVersion` | `null` |
| `icon` | icon trong bundle (base64 data URL) | icon mặc định CDN |

### Loại chứng chỉ / thiết bị (embedded.mobileprovision)

`getProfileType(mobileProvision)`:

| Điều kiện | `profileType` |
|-----------|---------------|
| `ProvisionsAllDevices` | Enterprise |
| Có danh sách `ProvisionedDevices` + entitlement `get-task-allow` | Development |
| Có danh sách `ProvisionedDevices`, không `get-task-allow` | Ad Hoc |
| Không có danh sách thiết bị + `get-task-allow` | Development |
| Còn lại | App Store |

Nếu có `ProvisionedDevices`, hệ thống lưu cả danh sách UDID và `provisionedDevicesCount` để trang cài đặt hiển thị (UDID được che một phần trên UI).

Parse thất bại → HTTP 500, không tạo link, không ghi catalog.

## 3. Tạo link tải / cài đặt

### 3.1 URL công khai của file IPA

- Upload local / LAN / chunk: `{PUBLIC_BASE_URL}/uploads/{finalFilename}`
- Upload R2: `{R2_PUBLIC_URL}/{r2ObjectKey}`

`PUBLIC_BASE_URL` mặc định `https://share-ipa.vunt.site`. Apple yêu cầu HTTPS cho OTA.

### 3.2 Manifest plist (chỉ iOS)

File ghi cạnh IPA:

```
{finalFilename}.plist
```

Ví dụ IPA `app_123_MyApp.ipa` → `app_123_MyApp.ipa.plist`.

Nội dung (Apple enterprise / ad-hoc manifest):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>items</key>
    <array>
      <dict>
        <key>assets</key>
        <array>
          <dict>
            <key>kind</key>
            <string>software-package</string>
            <key>url</key>
            <string>https://…/uploads/app_123_MyApp.ipa</string>
          </dict>
        </array>
        <key>metadata</key>
        <dict>
          <key>bundle-identifier</key>
          <string>com.example.app</string>
          <key>bundle-version</key>
          <string>1.2.0</string>
          <key>kind</key>
          <string>software</string>
          <key>title</key>
          <string>My App</string>
        </dict>
      </dict>
    </array>
  </dict>
</plist>
```

Các field metadata lấy từ bước parse. `url` trong `assets` là URL IPA ở mục 3.1.

### 3.3 Hai URL trả về client

```
manifestUrl  = {PUBLIC_BASE_URL}/uploads/{finalFilename}.plist
downloadUrl  = itms-services://?action=download-manifest&url={encodeURIComponent(manifestUrl)}
shareUrl     = {PUBLIC_BASE_URL}/install?plist={finalFilename}.plist
```

`downloadUrl` chỉ Safari / iOS hiểu. `shareUrl` dùng được trên mọi thiết bị (QR, Slack, email).

Phản hồi ngay sau khi parse xong:

```json
{
  "success": true,
  "downloadUrl": "itms-services://?action=download-manifest&url=…",
  "shareUrl": "https://share-ipa.vunt.site/install?plist=app_123_MyApp.ipa.plist",
  "processTime": "1.23",
  "appInfo": { "appName": "…", "bundleId": "…", "version": "…", "icon": "…" }
}
```

Với upload chunk / R2, client nhận `jobId` trước rồi poll `/api/upload-status/:jobId` để lấy object trên.

## 4. Việc làm nền sau khi đã có link

Không chặn phản hồi HTTP:

1. **Lưu trữ local (không R2):** copy IPA vào `storage/{appName}_{bundleId}/`, ghi `{filename}.json` metadata. Giữ tối đa 10 bản IPA mỗi thư mục app.
2. **R2:** object đã nằm trên R2; bản tải về máy được **đổi tên** thành `finalFilename` trong `uploads/` để phục vụ tải LAN.
3. **QR:** `QRCode.toDataURL(shareUrl)` — QR trỏ trang `/install`, không trỏ `itms-services://`.
4. **Catalog GitHub:** `appendToCatalog()` ghi `catalog-ios.json`. Mỗi app R2 tối đa 10 build; cả catalog tối đa `CATALOG_MAX_ITEMS` (200). Bản bị loại thì xóa file vật lý (R2 + cache LAN + plist).

## 5. Người dùng nhận file như thế nào

### 5.1 Trang cài đặt `/install`

Query:

- iOS: `?plist=app_123_MyApp.ipa.plist`
- Android: `?id=app_123_MyApp.apk`

Link cũ `/?plist=…` được `app.js` chuyển sang `/install`.

Trang gọi `GET /api/app-info?plist=…` (công khai, không cần đăng nhập):

1. Bỏ hậu tố `.plist` → `targetId` = id trong catalog.
2. Tìm bản ghi catalog; không có thì `fallbackBuildFromId()` dựng từ file còn trên đĩa.
3. Nếu app bị khoá VPN mà client chưa có grant → 403, UI cổng VPN.
4. Trả `downloadUrl`, `shareUrl`, metadata, `localFileAvailable`.

`install.js` gán `installBtn.href = item.downloadUrl`. Trên iPhone/iPad, sau ~1.2s trang tự `location.href` sang `itms-services://` để Safari mở dialog cài đặt.

### 5.2 Serve plist — rewrite URL IPA lúc tải

`GET /uploads/:filename.plist` **không** trả file tĩnh nguyên si. Server đọc plist rồi:

1. Đổi host cũ (`share-ipa.vunt.info`) sang host hiện tại.
2. Nếu IPA còn trên đĩa local: thay `<key>url</key><string>…</string>` bằng `{requestBaseUrl}/uploads/{ipaName}` (LAN dùng IP nội bộ, WAN dùng host public).
3. Nếu có token `?k=`: gắn vào URL IPA trong plist (iOS sẽ gửi token khi tải file).

Header: `Content-Type: application/xml`, `Cache-Control: no-cache`.

IPA/APK tĩnh: `Content-Disposition: attachment`.

### 5.3 Ưu tiên LAN

Khi request đến từ mạng nội bộ **và** file còn trong `uploads/`:

- Server (`toClientBuild`): `downloadUrl` dùng `requestBaseUrl` (IP LAN) thay vì `PUBLIC_BASE_URL`.
- Client (`lan.js`): probe `/api/lan-ping`; nếu cùng subnet thì build lại `itms-services://` trỏ plist LAN.

Lưu ý iOS: `itms-services` gần như bắt HTTPS (trừ localhost). LAN HTTP thường chỉ dùng được cho Android.

### 5.4 App khoá VPN

App đánh dấu `vpnRequired` trong `app-visibility.json`:

- Không có VPN / LAN: ẩn `downloadUrl` / `shareUrl` / QR; chặn `GET /uploads/*.ipa|*.plist`.
- Có VPN grant: server phát `fileAccessToken` (`auth.createFileAccessToken`), nhét `?k=` vào URL manifest (và vào URL IPA bên trong plist). Token hết hạn theo `VPN_GRANT_TTL_SEC`.

## 6. Khôi phục catalog từ file sẵn có

`node rebuild-catalog.js` quét `uploads/` các file `app_*.ipa` / `app_*.apk` chưa có trong catalog, parse giống `mapParsedAppInfo`, tạo plist nếu thiếu, rồi đẩy GitHub. `--dry-run` chỉ in danh sách.

## Sơ đồ tuần tự (iOS)

```
Tester / Uploader                 Server                         iPhone Safari
        |                            |                                |
        |  POST IPA                  |                                |
        |--------------------------->|                                |
        |                            | AppInfoParser.parse()          |
        |                            | ghi app_….ipa.plist            |
        |  { shareUrl, downloadUrl } |                                |
        |<---------------------------|                                |
        |                            | catalog + QR (nền)             |
        |                            |                                |
        |  chia sẻ shareUrl (QR)     |                                |
        |----------------------------------------------------------->|
        |                            |  GET /install?plist=…          |
        |                            |<-------------------------------|
        |                            |  GET /api/app-info             |
        |                            |<-------------------------------|
        |                            |  item.downloadUrl              |
        |                            |------------------------------->|
        |                            |  itms-services://…             |
        |                            |  GET /uploads/….plist          |
        |                            |<-------------------------------|
        |                            |  plist (url IPA đã rewrite)    |
        |                            |------------------------------->|
        |                            |  GET /uploads/….ipa            |
        |                            |<-------------------------------|
        |                            |  binary IPA                    |
        |                            |------------------------------->|
        |                            |                   dialog cài đặt
```

## File liên quan

| File | Vai trò |
|------|---------|
| `server.js` — `processUploadedIpa`, `mapParsedAppInfo`, `getProfileType` | Parse IPA, tạo plist + URL |
| `server.js` — `GET /uploads/:filename` | Rewrite plist khi iOS tải manifest |
| `server.js` — `GET /api/app-info`, `toClientBuild` | Trả link cho trang cài đặt |
| `public/js/install.js` | Gán nút cài, auto-redirect iOS |
| `public/js/lan.js` | Đổi link sang host LAN khi cùng mạng |
| `rebuild-catalog.js` | Parse lại IPA trên đĩa, tái tạo catalog/plist |
| `auth.js` | Token `k` cho file khi app yêu cầu VPN |
