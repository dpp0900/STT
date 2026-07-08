export interface PlaudDevice {
  sn: string;
  name: string;
  model: string;
  version_number: number;
}

export interface PlaudDeviceListResponse {
  status: number;
  msg: string;
  data_devices: PlaudDevice[];
}

export interface PlaudRecording {
  id: string;
  filename: string;
  keywords?: string[];
  filesize: number;
  filetype?: string;
  fullname?: string;
  file_md5: string;
  ori_ready?: boolean;
  version?: number;
  version_ms: number;
  edit_time?: number;
  edit_from?: string;
  is_trash: boolean;
  start_time: number;
  end_time: number;
  duration: number;
  timezone: number;
  zonemins: number;
  scene: number;
  filetag_id_list?: string[];
  serial_number: string;
  is_trans?: boolean;
  is_summary?: boolean;
}

export interface PlaudRecordingsResponse {
  status: number;
  msg: string;
  data_file_total: number;
  data_file_list: PlaudRecording[];
}

export interface PlaudTempUrlResponse {
  status: number;
  msg?: string;
  temp_url: string;
  temp_url_opus?: string;
}

export interface PlaudWorkspace {
  workspace_id: string;
  member_id: string;
  name: string;
  role: string;
  status: string;
  workspace_type: string;
  region?: string;
  api_domain?: string;
  domain?: string;
}

export interface PlaudWorkspaceListResponse {
  status: number;
  msg?: string;
  data: {
    workspaces: PlaudWorkspace[];
  };
}

export interface PlaudWorkspaceTokenResponse {
  status: number;
  msg?: string;
  data: {
    workspace_token: string;
    workspace_id: string;
    member_id: string;
    role: string;
  };
}
