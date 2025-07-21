require("dotenv").config();
const archiver = require("archiver");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const { Pool } = require("pg");
const { EmailClient } = require("@azure/communication-email");
const multer = require("multer");
const path = require("path");

const app = express();
app.use(express.json());

// Application Gatewayからのヘッダーを信頼
app.set("trust proxy", true);

// X-Forwarded-Protoヘッダーをチェック
// app.use((req, res, next) => {
//   if (req.header("x-forwarded-proto") !== "https") {
//     res.redirect(`https://${req.header("host")}${req.url}`);
//   } else {
//     next();
//   }
// });

// 通常のミドルウェア設定
app.use(express.json());
// app.use("/api/users", require("./routes/users"));

// 一時ファイル保存先
const upload = multer({ dest: "uploads/" });
const uploadsDir = path.join(__dirname, "uploads");

// uploadsディレクトリが存在しない場合は作成
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const connectionString = process.env.CONNECTION_STRING;
const emailClient = new EmailClient(connectionString);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

/**
 * 一時ファイルを削除する関数
 * @param {string[]} excludeFiles - 削除対象から除外するファイル名の配列
 */
function cleanupTempFiles(excludeFiles = []) {
  try {
    const files = fs.readdirSync(uploadsDir);
    files.forEach((file) => {
      if (!excludeFiles.includes(file)) {
        const filePath = path.join(uploadsDir, file);
        if (fs.statSync(filePath).isFile()) {
          fs.unlinkSync(filePath);
          console.log(`Deleted temp file: ${file}`);
        }
      }
    });
  } catch (error) {
    console.error("Error cleaning up temp files:", error.message);
  }
}

// データベースのphotosテーブルにレコードを追加する
async function addRecord(hashValue) {
  return await pool.query(
    `INSERT INTO photos (hash_value) VALUES ('${hashValue}') RETURNING *`
  );
}

/* * Boxのメールアップロード機能を使用して、zipファイルを送信する
 * @param {string} zipPath - zipファイルのパス
 * @param {string} zipFileName - zipファイル名
 * @returns {Promise<number>} - HTTPステータスコード
 */
async function sendBoxFile(zipPath) {
  const zipFileName = path.basename(zipPath);
  // zipファイルの内容を取得する
  const content = fs.readFileSync(zipPath);
  // zipファイルの内容をBase64エンコードする
  const base64Content = content.toString("base64");

  // メール内容
  const emailMessage = {
    senderAddress: process.env.SENDER_ADDRESS,
    content: {
      subject: "Test Email",
      plainText: "Hello world via email.",
      html: `
      <html>
        <body>
          <h1>Hello world via email.</h1>
        </body>
      </html>`,
    },
    attachments: [
      {
        name: zipFileName,
        attachmentType: "File",
        contentType: "application/zip",
        contentInBase64: base64Content,
      },
    ],
    recipients: {
      to: [{ address: process.env.RECIPIENT_ADDRESS }],
    },
  };

  try {
    // メールを送信する
    const response = await emailClient.beginSend(emailMessage);
    console.log("Email sent successfully");
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

app.post("/api/user", async (req, res) => {
  // パラメータを取得
  const blockchainAccountAddress = req.body.blockchainAccountAddress || ""; // ブロックチェーンアカウントアドレス
  const nickname = req.body.nickname || ""; // ニックネーム
  const tokenId = ""; // トークンIDはブロックチェーンサーバーから取得するため、ここでは空文字列
  res.status(200).send({
    message: "add user successfully",
    blockchainAccountAddress,
    nickname,
    tokenId,
  });
});

// "file"はhtmlのnam属性と一致させる
app.post("/api/box", upload.single("file"), async (req, res) => {
  // サーバー側でアップロードされたファイルをリネームする
  const oldFile = path.join(uploadsDir, req.file.filename);
  const newFile = path.join(uploadsDir, req.file.originalname);
  fs.renameSync(oldFile, newFile);

  // パラメータを取得
  const blockchainAccountAddress = req.body.blockchainAccountAddress || ""; // ブロックチェーンアカウントアドレス
  const nickname = req.body.nickname || ""; // ニックネーム
  const comment = req.body.comment || ""; // コメント

  // ブロックチェーンアカウントアドレス、ニックネーム、コメントからハッシュ値を生成する
  const hash = crypto
    .createHash("sha256")
    .update(`${blockchainAccountAddress}${nickname}${comment}`)
    .digest("hex");

  try {
    // DBに保存する
    const response = await addRecord(hash);

    console.log("DB response:", response.status, response.statusText);

    // ファイル一覧を作成する
    const textFiles = [
      { name: "nickname.txt", content: nickname },
      { name: "comment.txt", content: comment },
      { name: "hash.txt", content: hash },
    ];

    // ファイル一覧をuploadsディレクトリに保存する
    textFiles.forEach((file) => {
      fs.writeFileSync(`uploads/${file.name}`, file.content, "utf8");
    });

    // zipファイル名を作成する
    const datetime = new Date();
    const zipFileName = [
      datetime.getFullYear(),
      String(datetime.getMonth() + 1).padStart(2, "0"),
      String(datetime.getDate()).padStart(2, "0"),
      String(datetime.getHours()).padStart(2, "0"),
      String(datetime.getMinutes()).padStart(2, "0"),
      String(datetime.getSeconds()).padStart(2, "0"),
      String(datetime.getMilliseconds()).padStart(3, "0"),
    ].join("");

    // zipファイルのパスを作成する
    const zipPath = path.join(uploadsDir, `${zipFileName}.zip`);
    // ファイル書き込みストリーム作成する
    const output = fs.createWriteStream(zipPath);
    // archiverを使用してzipファイルを作成する
    const archive = archiver("zip");

    // zipファイルの書き込みが完了したときの処理
    output.on("close", async () => {
      try {
        console.log("file", fs.readdirSync(uploadsDir));
        const response = await sendBoxFile(zipPath);

        // メール送信成功後、一時ファイルをクリーンアップ
        cleanupTempFiles();
        const tokenId = ""; // トークンIDはブロックチェーンサーバーから取得するため、ここでは空文字列

        res.status(200).send({
          message: "Zip file created and sent via email",
          zipFileName: `${path.basename(zipPath)}`,
          tokenId,
        });
      } catch (error) {
        console.error("Error sending zip file via email:", error.message);

        // エラー時も一時ファイルをクリーンアップ
        cleanupTempFiles();

        res
          .status(500)
          .send("Failed to send zip file via email: " + error.message);
      }
    });

    // zipファイルの書き込みエラー処理
    archive.on("error", (err) => {
      console.error("Error creating zip file:", err);

      // エラー時も一時ファイルをクリーンアップ
      cleanupTempFiles();

      res.status(500).send("Failed to create zip file: " + err.message);
      throw err;
    });

    // zipファイルのストリームとarchiverを紐づける
    archive.pipe(output);

    // アップロードされたファイルをzipに追加する
    fs.readdirSync(uploadsDir).forEach((file) => {
      const filePath = path.join(uploadsDir, file);
      if (fs.statSync(filePath).isFile()) {
        if (file != `${zipFileName}.zip`) {
          archive.file(filePath, { name: file });
        }
      }
    });

    // zipファイルを作成する
    archive.finalize();
  } catch (error) {
    console.error("Error connecting to the database:", error.message);

    // データベースエラー時も一時ファイルをクリーンアップ
    cleanupTempFiles();

    res.status(500).send("Database error: " + error.message);
  }
});

app.get("/health", async (req, res) => {
  res.status(200).send("App Server OK\n");
});

app.listen(4000, () => {
  console.log("Server is running on port 4000");

  // サーバー起動時に既存の一時ファイルをクリーンアップ
  cleanupTempFiles();
  console.log("Cleaned up temporary files on server start");
});
