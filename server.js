import express from 'express';
import multer from 'multer';
import fs from 'fs';
import cors from 'cors';
import { FaceSdk, ImageSource } from '@regulaforensics/facesdk-webclient';
import {
    DocumentReaderApi,
    Scenario,
    Light,
    Source,
    GraphicFieldType,
    TextFieldType,
    Result
} from '@regulaforensics/document-reader-webclient';
import 'dotenv/config'; 

const { DOCUMENT_NUMBER, SURNAME_AND_GIVEN_NAMES, DATE_OF_BIRTH } = TextFieldType;
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT;
const DOC_READER_URL = process.env.DOC_READER_URL;
const FACE_SDK_URL = process.env.FACE_SDK_URL;

const faceSdk = new FaceSdk({ basePath: FACE_SDK_URL });
const docApi = new DocumentReaderApi({ basePath: DOC_READER_URL });

const cleanupFiles = (files) => {
    files.forEach(path => {
        if (fs.existsSync(path)) fs.unlinkSync(path);
    });
};

app.post('/api/verify', upload.fields([{ name: 'passport' }, { name: 'selfie' }]), async (req, res) => {
    const { passport, selfie } = req.files || {};
    const cleanupList = [];

    if (passport?.[0]) cleanupList.push(passport[0].path);
    if (selfie?.[0]) cleanupList.push(selfie[0].path);

    if (!passport || !selfie) {
        cleanupFiles(cleanupList);
        return res.status(400).json({ error: 'Passport and selfie files are required' });
    }

    try {
        console.log(`[INFO] Processing: ${passport[0].originalname} & ${selfie[0].originalname}`);

        const passportBuffer = fs.readFileSync(passport[0].path).buffer;
        const selfieBase64 = fs.readFileSync(selfie[0].path).toString('base64');

        console.log('[INFO] Sending to Document Reader...');
        const docResponse = await docApi.process({
            images: [
                {
                    ImageData: passportBuffer,
                    light: Light.WHITE,
                    page_idx: 0,
                },
            ],
            processParam: {
                scenario: Scenario.FULL_PROCESS,
                alreadyCropped: false, 
            },
        });
        const getFieldVal = (type) => {
            const field = docResponse.text?.getField(type);
            return field ? field.value : null;
        };

        const docType = docResponse.documentType()?.DocumentName || 'UNKNOWN';
        
        const docData = {
            number: getFieldVal(DOCUMENT_NUMBER),
            name: getFieldVal(SURNAME_AND_GIVEN_NAMES),
            dob: getFieldVal(DATE_OF_BIRTH),
            type: docType
        };

        const overallStatus = docResponse.status.overallStatus;

        console.log('--------------------------------------------------');
        console.log(`[DEBUG] STATUSES (0=OK, 1=WARN, 2=ERR):`);
        console.log(`Overall: ${overallStatus}`);
        console.log(`Type: ${docType}`);
        console.log(`Name Extracted: ${docData.name ? 'YES' : 'NO'}`);
        console.log('--------------------------------------------------');

        const docErrors = [];

        if (overallStatus === Result.ERROR) {
            docErrors.push("Overall status is ERROR");
        }

        if (docType === 'UNKNOWN' || !docType) {
            docErrors.push("Unknown document type (Not recognized)");
        }

        if (!docData.number && !docData.name) {
            docErrors.push("No text data extracted (Blurry or blank image)");
        }

        const isDocumentValid = overallStatus !== Result.ERROR && 
                                docType !== 'UNKNOWN' &&
                                (docData.number !== null || docData.name !== null);

        console.log(`[INFO] Document Valid Decision: ${isDocumentValid ? 'VALID' : 'INVALID'}`);
        if (!isDocumentValid) console.log(`[INFO] Errors: ${docErrors.join(', ')}`);

        const portraitField = docResponse.images.getField(GraphicFieldType.PORTRAIT);
        if (!portraitField) {
            throw new Error('Portrait not found in document');
        }

        const portraitDataArray = portraitField.getValue(Source.VISUAL) || portraitField.getValue(Source.RFID);
     
        const docFaceBase64 = Buffer.from(portraitDataArray).toString('base64');

        console.log('[INFO] Matching faces...');
        
        const matchResponse = await faceSdk.matchApi.match({
            images: [
                {
                    type: ImageSource.DOCUMENT_PRINT,
                    data: docFaceBase64,
                    index: 1
                },
                {
                    type: ImageSource.LIVE,
                    data: selfieBase64,
                    index: 2
                }
            ]
        });

        const results = matchResponse.results || matchResponse.Results;
        if (!results || results.length === 0) {
            throw new Error("No match results returned from Face SDK");
        }

        const similarity = results[0].similarity * 100;
        const isFaceMatch = similarity > 75;

        console.log(`[INFO] Similarity: ${similarity.toFixed(2)}%`);

        res.json({
            success: isFaceMatch && isDocumentValid,
            verificationStatus: (isFaceMatch && isDocumentValid) ? 'VERIFIED' : 'REJECTED',
            checks: {
                faceMatch: {
                    passed: isFaceMatch,
                    similarity: parseFloat(similarity.toFixed(2))
                },
                documentValidation: {
                    passed: isDocumentValid,
                    status: overallStatus, 
                    errors: docErrors
                }
            },
            data: docData
        });

    } catch (error) {
        console.error('[ERROR] Processing failed:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    } finally {
        cleanupFiles(cleanupList);
    }
});

app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));