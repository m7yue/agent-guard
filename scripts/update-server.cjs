#!/usr/bin/env node
// 本地更新源：把 dist/feed 当静态目录提供服务，模拟真实更新服务器。
//
// 目录结构决定灰度：请求 /beta/latest-mac.yml 就是 beta 渠道，
// /stable/latest-mac.yml 就是 stable 渠道——分流在路径上，不在客户端逻辑里。
//
// 用法：node scripts/update-server.cjs [端口，默认 9999]
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', 'dist', 'feed')
const port = Number(process.argv[2] ?? 9999)

const types = {
  '.yml': 'text/yaml; charset=utf-8',
  '.zip': 'application/zip',
  '.blockmap': 'application/octet-stream',
}

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const file = path.join(root, urlPath)

    // 简单防穿越：解析后的路径必须还在 feed 目录内
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden')
      return
    }

    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      console.log(`404 ${urlPath}`)
      res.writeHead(404).end('not found')
      return
    }

    console.log(`200 ${urlPath}（${fs.statSync(file).size} 字节）`)
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`更新源已启动：http://127.0.0.1:${port}/beta/latest-mac.yml`)
  })
