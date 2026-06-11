const { v2: cloudinary } = require('cloudinary');

const hasRealValue = (value) => Boolean(value && !String(value).startsWith('your_'));

const hasCloudinaryConfig = () =>
  hasRealValue(process.env.CLOUDINARY_CLOUD_NAME) &&
  hasRealValue(process.env.CLOUDINARY_API_KEY) &&
  hasRealValue(process.env.CLOUDINARY_API_SECRET);

const configureCloudinary = () => {
  if (!hasCloudinaryConfig()) {
    return false;
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  return true;
};

const uploadToCloudinary = async (fileOrUrl, folder = 'samosa-chowk/menu') => {
  if (!configureCloudinary()) {
    throw new Error('Cloudinary credentials are not configured in server .env');
  }

  if (typeof fileOrUrl === 'string') {
    const result = await cloudinary.uploader.upload(fileOrUrl, {
      folder,
      resource_type: 'image',
    });
    return result.secure_url;
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result.secure_url);
      }
    );

    stream.end(fileOrUrl.buffer);
  });
};

module.exports = { uploadToCloudinary };
